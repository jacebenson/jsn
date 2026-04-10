# Flow Variables: The Foundation of Flow Logic

## Core Principle

**All logic gates (If/Else/For Each) require flow variables.**

You cannot write `condition=dayOfWeek()==1`. Instead:

1. Create a flow variable
2. Set its value (with a script if needed)
3. Reference the variable in your logic

## The Pattern

```bash
# 1. Create the flow variable FIRST
jsn flows variables add "My Flow" --name is_monday --type boolean

# 2. Set the variable value
jsn flows actions add "My Flow" --type set_variable \
  --variable is_monday \
  --script "new Date().getDay() === 1"

# 3. Use the variable in logic
jsn flows actions add "My Flow" --type if \
  --input "condition={{flow_variable.is_monday}}=true"
```

## Why This Pattern?

### ✅ Explicit Data Flow
Variables make data flow visible. You can see exactly what data the condition depends on.

### ✅ Reusable Logic
Variables can be referenced multiple times:

```bash
# Set once
jsn flows variables add "My Flow" --name priority_level --type string

# Use in multiple places
jsn flows actions add "My Flow" --type if \
  --input "condition={{flow_variable.priority_level}}=high"

jsn flows actions add "My Flow" --type if \
  --input "condition={{flow_variable.priority_level}}=critical"
```

### ✅ Testable
You can inspect variable values during flow execution to debug logic.

### ✅ ServiceNow Native
This matches how Flow Designer actually works - conditions use "pills" (variable references), not raw expressions.

## Common Variables for Logic

| Use Case | Variable | Script | Condition |
|----------|----------|--------|-----------|
| Day of week | `day_of_week` | `new Date().getDay()` | `{{flow_variable.day_of_week}}=1` |
| Is Monday | `is_monday` | `new Date().getDay() === 1` | `{{flow_variable.is_monday}}=true` |
| Current hour | `current_hour` | `new Date().getHours()` | `{{flow_variable.current_hour}}<17` |
| Priority check | `is_high_priority` | `fd_data.trigger.current.priority < 3` | `{{flow_variable.is_high_priority}}=true` |
| Business hours | `in_business_hours` | Complex script | `{{flow_variable.in_business_hours}}=true` |

## Helper: Variable Pill Generator

Use the SDK helper to generate pill references:

```go
// In code
pill := sdk.FlowVariablePill("is_monday")  // Returns "{{flow_variable.is_monday}}"
```

Or just remember the pattern:
```
{{flow_variable.<variable_name>}}
```

## Validation

The CLI should (and will) validate that:

1. Variables referenced in conditions exist
2. Variable types match comparison values
3. Variables are set before they're used

Example error:
```
Error: Variable 'is_monday' not found
Create it first:
  jsn flows variables add "My Flow" --name is_monday --type boolean
```

## Complete Example: Monday Priority Flow

```bash
#!/bin/bash
FLOW="Monday Priority Handler"

# Create flow
jsn flows create --name "$FLOW"

# Add trigger
jsn flows triggers add "$FLOW" --type created --table incident

# Create variables for logic
jsn flows variables add "$FLOW" --name is_monday --type boolean
jsn flows variables add "$FLOW" --name is_high_priority --type boolean
jsn flows variables add "$FLOW" --name requires_immediate_attention --type boolean

# Set variable values
jsn flows actions add "$FLOW" --type set_variable \
  --variable is_monday \
  --script "new Date().getDay() === 1"

jsn flows actions add "$FLOW" --type set_variable \
  --variable is_high_priority \
  --script "fd_data.trigger.current.priority < 3"

jsn flows actions add "$FLOW" --type set_variable \
  --variable requires_immediate_attention \
  --script "fd_data.trigger.current.priority == 1 && new Date().getDay() === 1"

# Use variables in logic
jsn flows actions add "$FLOW" --type if \
  --input "condition={{flow_variable.requires_immediate_attention}}=true" \
  --input "label=Immediate Attention Required"

# Add actions (may need to move inside If)
jsn flows actions add "$FLOW" --type update_record --table incident \
  --input "record={{trigger.current}}" \
  --input "fields=work_notes=ESCALATED: Monday high priority incident"

# Move action inside If
jsn flows actions list "$FLOW"  # Get IDs
jsn flows actions move "$FLOW" <action_id> --parent <if_id>
```

## Benefits Summary

| Without Variables | With Variables |
|-------------------|----------------|
| `condition=dayOfWeek()==1` ❌ | `condition={{flow_variable.is_monday}}=true` ✅ |
| Magic expressions | Explicit data flow |
| Hard to debug | Inspect variable values |
| Can't reuse logic | Reference multiple times |
| Breaks silently | Validated by CLI |
| Confusing errors | Clear "variable not found" errors |

## The Rule

> **Every logic gate must reference at least one flow variable.**

If you find yourself wanting to write:
```bash
--input "condition=someFunction()"
```

Stop. Create a variable instead:
```bash
jsn flows variables add "My Flow" --name my_value --type string
jsn flows actions add "My Flow" --type set_variable --variable my_value --script "someFunction()"
jsn flows actions add "My Flow" --type if --input "condition={{flow_variable.my_value}}=expected"
```

This is the **Flow Variables First** approach.
