# Flow Designer CLI

Building and managing ServiceNow Flow Designer flows from the command line.

> **⚠️ UX Debt Notice**: This CLI is powerful but has sharp edges. See [UX Issues & Roadmap](#ux-issues--roadmap) for known problems.

## Quick Start

```bash
# Create a flow
jsn flows create --name "My Flow" --type flow

# Add trigger
jsn flows triggers add "My Flow" --type created --table incident

# Add action
jsn flows actions add "My Flow" --type log --input "message=Hello"
```

## Architecture

```
jsn flows              # List/view flows
jsn flows triggers     # Manage triggers (when flows run)
jsn flows actions      # Manage actions (what flows do)
jsn flows variables    # Manage flow variables (data for pills)
```

## Flow Management

### Create Flows & Subflows

```bash
# Interactive mode
jsn flows create

# Non-interactive
jsn flows create --name "My Flow" --type flow
jsn flows create --name "My Helper" --type subflow --run-as system
```

### Inspect Flows

```bash
jsn flows                              # List all flows
jsn flows "My Flow"                    # Show flow structure
jsn flows "My Flow" --json             # Raw JSON
```

## Trigger Management

### List Triggers

```bash
jsn flows triggers list "My Flow"
```

### Add Record Triggers

```bash
# Created
jsn flows triggers add "My Flow" --type created --table incident

# Updated
jsn flows triggers add "My Flow" --type updated --table incident

# Created or Updated
jsn flows triggers add "My Flow" --type created_or_updated --table change_request

# With condition
jsn flows triggers add "My Flow" --type created --table incident \
  --condition "priority=1"
```

### Add Scheduled Triggers

```bash
# Daily at 8am
jsn flows triggers add "My Flow" --schedule daily --time "08:00:00"

# Weekly on Monday at 9am
jsn flows triggers add "My Flow" --schedule weekly --day 1 --time "09:00:00"
```

## Action Management

### List Actions

```bash
jsn flows actions list "My Flow"
```

### Add Actions

```bash
# Interactive mode
jsn flows actions add "My Flow"

# List available types
jsn flows actions add --list-types
```

**Available Action Types:**

| Type | Description |
|------|-------------|
| `create_record` | Insert a new record |
| `update_record` | Update fields (use for adding comments/work notes) |
| `delete_record` | Remove a record |
| `lookup_record` | Query for records |
| `log` | Write a log message |
| `set_variable` | Calculate and set flow variable values |
| `if` | Conditional logic block |
| `else` | Else branch for If block |

### Order and Parent for Nested Actions

**⚠️ Critical**: Actions inside If/For Each blocks require both `--order` and `--parent` flags.

Order is **global** across the entire flow, not scoped to each block:
- Set Flow Variables: typically order 1
- If / For Each: typically order 2
- Actions inside logic blocks: order 3+ (higher than the enclosing logic)

```bash
# 1. Set Variable at order 1
jsn flows actions add "My Flow" --type set_variable \
  --variable current_day --script "new GlideDateTime().getDayOfWeek()" \
  --order 1

# 2. If block at order 2
jsn flows actions add "My Flow" --type if \
  --input "condition={{flow_variable.current_day}}=2" \
  --input "label=Is it Monday?" \
  --order 2

# 3. Action INSIDE If - must use --parent and --order 3
# First save to get the If block's UI ID
jsn flows save "My Flow"

# Then add the action with parent UI ID and order 3
jsn flows actions add "My Flow" --type update_record --table incident \
  --input "record={{trigger.current}}" \
  --input "values=work_notes=Do you have a case of the Mondays?" \
  --parent "<if_block_ui_id>" --order 3
```

### Record Actions

```bash
# Create a new record
jsn flows actions add "My Flow" --type create_record --table incident

# Update a record (add work note) - use "values" not "fields"
jsn flows actions add "My Flow" --type update_record --table incident \
  --input "record={{trigger.current}}" \
  --input "values=work_notes=My comment here"

# Delete a record
jsn flows actions add "My Flow" --type delete_record --table incident \
  --input "record={{trigger.current}}"

# Look up records
jsn flows actions add "My Flow" --type lookup_record --table incident \
  --input "conditions=active=true"
```

### Set Flow Variables

This action calculates values and stores them in flow variables:

```bash
jsn flows actions add "My Flow" --type set_variable \
  --variable day_of_week \
  --script "new GlideDateTime().getDayOfWeek()" \
  --order 1
```

### Logic Blocks (Variables Required!)

**⚠️ Important**: Logic gates (If/Else) require flow variables. You cannot use raw expressions like `dayOfWeek()==1`.

See [FLOWS_VARIABLES.md](FLOWS_VARIABLES.md) for the complete pattern.

```bash
# 1. Create variable FIRST
jsn flows variables add "My Flow" --name is_monday --type boolean

# 2. Set the variable value at order 1
jsn flows actions add "My Flow" --type set_variable \
  --variable is_monday \
  --script "new GlideDateTime().getDayOfWeek() === 1" \
  --order 1

# 3. Reference variable in If condition at order 2
jsn flows actions add "My Flow" --type if \
  --input "condition={{flow_variable.is_monday}}=true" \
  --input "label=Is Monday" \
  --order 2

# 4. Add Else (must follow an If) - save first to get If's UI ID
jsn flows save "My Flow"
jsn flows actions add "My Flow" --type else --parent "<if_ui_id>"
```

### Remove Actions

```bash
# Remove an action by its sys_id
jsn flows actions remove "My Flow" <action_sys_id>

# Get action IDs by listing first
jsn flows actions list "My Flow"
```

## Flow Variables

Flow variables store data that can be referenced in actions and conditions using "pill" syntax.

### List Variables

```bash
jsn flows variables list "My Flow"
```

### Add Variables

```bash
# Add a string variable
jsn flows variables add "My Flow" --name day_of_week --type string

# Add with label and default
jsn flows variables add "My Flow" --name status --type string \
  --label "Current Status" --default "new"

# Add mandatory integer
jsn flows variables add "My Flow" --name priority --type integer \
  --mandatory --default 3
```

**Variable Types:**
- `string` - Text values
- `integer` - Whole numbers
- `boolean` - true/false
- `reference` - Reference to another record
- `choice` - Selection from options

### Using Variables (Pills)

Once created, variables can be referenced:

```bash
# In conditions
--input "condition={{flow_variable.day_of_week}}=1"

# In actions
--input "fields=work_notes=Priority: {{flow_variable.priority}}"
```

## Saving Flows

**⚠️ CRITICAL**: After making structural changes (adding variables, actions, triggers), you **must** save the flow to regenerate the version payload. Flow Designer reads from this payload snapshot.

```bash
# Save after making changes
jsn flows save "My Flow"

# Save by sys_id
jsn flows save <flow_sys_id>
```

**Without saving**, changes won't appear in Flow Designer!

## Complete Example: Jace Monday Check

```bash
#!/bin/bash
FLOW="Jace Monday Check"

# 1. Create the flow
jsn flows create --name "$FLOW"

# 2. Add trigger - when incident created with "jace" in description
jsn flows triggers add "$FLOW" \
  --type created \
  --table incident \
  --condition "short_descriptionLIKEjace"

# 3. Create flow variable for day of week
jsn flows variables add "$FLOW" \
  --name day_of_week \
  --type integer \
  --label "Day of Week (0=Sun, 1=Mon, ...)"

# 4. Add Set Flow Variables action to calculate day
jsn flows actions add "$FLOW" --type set_variable \
  --variable day_of_week \
  --script "new Date().getDay()"

# 5. Add If condition to check if Monday
jsn flows actions add "$FLOW" --type if \
  --input "condition={{flow_variable.day_of_week}}=1" \
  --input "label=Is Monday"

# 6. Add update action inside If (get the If ID from list first)
jsn flows actions list "$FLOW"  # Note the If block ID
jsn flows actions add "$FLOW" --type update_record --table incident \
  --input "record={{trigger.current}}" \
  --input "fields=work_notes=Do you have a case of the Mondays?" \
  --parent <if_block_id>  # Use the ID from list

# 7. SAVE THE FLOW - Critical to make changes visible in Flow Designer!
jsn flows save "$FLOW"
```

## UX Issues & Roadmap

### 🔴 Critical Issues (Fix in Progress)

#### 1. **Phantom Actions**
**Problem**: Sometimes mystery Log actions appear that weren't requested.
**Status**: Under investigation - may be ServiceNow API behavior
**Workaround**: Remove phantom actions with:
```bash
jsn flows actions remove "My Flow" <phantom_action_id>
```

#### 2. **No Auto-Nesting**
**Problem**: Actions added after an `if` block appear at the same level, not inside it.
**Example of broken flow**:
```
1. If: Is Monday?
2. Update Record  ← This should be INSIDE the If, but it's a sibling
```
**Workaround**: Use the `move` command after creating:
```bash
# Add the action (creates at wrong level)
jsn flows actions add "My Flow" --type update_record --table incident ...

# Then move it inside the If block
jsn flows actions list "My Flow"  # Get the If block ID
jsn flows actions move "My Flow" <action_id> --parent <if_block_id>
```

#### 3. **Variables-First Design** ✅ BY DESIGN
**Not a bug!** Logic gates require flow variables. This is intentional.

**Why**: Flow Designer uses "pill" references (`{{flow_variable.name}}`), not raw expressions.

**The Pattern**:
```bash
# ❌ Won't work:
jsn flows actions add "My Flow" --type if \
  --input "condition=dayOfWeek()==1"

# ✅ Correct approach:
# 1. Create variable
jsn flows variables add "My Flow" --name is_monday --type boolean

# 2. Set its value
jsn flows actions add "My Flow" --type set_variable \
  --variable is_monday --script "new Date().getDay() === 1"

# 3. Reference in logic
jsn flows actions add "My Flow" --type if \
  --input "condition={{flow_variable.is_monday}}=true"
```

See [FLOWS_VARIABLES.md](FLOWS_VARIABLES.md) for details.

#### 4. **Cryptic Parent IDs**
**Problem**: The `--parent` flag requires UI unique IDs like `6b0fd383-aba7-4387-8a22-5afc96319acd` instead of human-readable names.
**Workaround**: Use `jsn flows actions list` to find IDs, or use interactive mode which tracks context.

### 🟡 Planned Improvements

#### 5. **Declarative YAML Mode**
```yaml
# flow.yaml
trigger:
  type: record_create
  table: incident
  condition: short_descriptionLIKEjace

variables:
  - name: today_day_of_week
    type: integer

actions:
  - type: set_variable
    variable: today_day_of_week
    script: new Date().getDay()
  
  - type: if
    condition: "{{flow_variable.today_day_of_week}} == 1"
    label: Is Monday
    actions:  # Nested!
      - type: update_record
        table: incident
        fields:
          work_notes: "Do you have a case of the Mondays?"
```

Usage:
```bash
jsn flows create --file flow.yaml
```

#### 6. **Dry-Run Mode**
```bash
jsn flows create --name "Test" --dry-run
# Shows what would be created and validates structure
```

#### 7. **Smart Auto-Nesting**
After creating an `if` block, automatically nest subsequent actions inside it unless `--sibling` is specified.

#### 8. **Friendly Parent References**
```bash
# Instead of:
--parent "6b0fd383-aba7-4387-8a22-5afc96319acd"

# Support:
--parent "If: Is Monday?"
--parent "if_1"
```

### 🟢 Minor Improvements

- Better error messages explaining what's wrong
- Formula support in variables: `--formula "dayOfWeek()"`
- Built-in common formulas (today, now, dayOfWeek, etc.)
- Flow validation before publishing

## How It Works Under the Hood

### API Strategy

ServiceNow's Table API doesn't work well for flow components. We use:

1. **Processflow API** — `POST /api/now/processflow/flow` — creates flow records
2. **GraphQL API** — `POST /api/now/graphql` with `snFlowDesigner` mutations — adds triggers, actions, variables

### Safe Edit Lock

Before any GraphQL mutation, we acquire a "safe edit" lock via `sys_hub_flow_safe_edit`. This is the same mechanism Flow Designer uses.

### Flow Variables & Pills

Flow Designer uses a sophisticated system:

1. **Flow Variable Creation** — Creates variable with metadata
2. **Label Cache** — Maps internal names to display labels  
3. **Pill References** — Format like `{{flow_variable.name}}`

### Key Tables

- `sys_hub_flow` — flow definition
- `sys_hub_flow_version` — version records with full payload JSON
- `sys_hub_trigger_instance` — trigger instances
- `sys_hub_action_instance` / `sys_hub_action_instance_v2` — action instances  
- `sys_hub_flow_logic` — logic blocks (If/Else/For Each)
- `sys_hub_flow_variable` — flow variables

### Definition IDs

**Trigger Types:**
| Type | Definition ID |
|------|--------------|
| created | `798916a0c31322002841b63b12d3ae7c` |
| updated | `bb695e60c31322002841b63b12d3aea5` |
| created_or_updated | `a45d9180c32222002841b63b12d3aea7` |

**Action Types:**
| Type | Sys ID |
|------|--------|
| create_record | `ab575ae253b3230034c6ddeeff7b12f1` |
| update_record | `5bc1bcc6531003003bf1d9109ec587d4` |
| delete_record | `c3e09916c31332002841b63b12d3aedf` |
| lookup_record | `43400a1587003300663ca1bb36cb0b4b` |
| log | `80a30edeff30311077a95dac793bf19b` |
| set_variable | `c3dc8600532003003bf1d9109ec58742` |

**Logic Types:**
| Type | Definition ID |
|------|--------------|
| if | `af4e1945c3e232002841b63b12d3ae3e` |
| elseif | `666e5545c3e232002841b63b12d3ae99` |
| else | `1f781bf3c32232002841b63b12d3aee6` |
| foreach | `098e1dc5c3e232002841b63b12d3ae33` |

## Contributing

This CLI is evolving. Report UX issues with the `jsn feedback` command or open issues on GitHub.

## License

MIT
