# Flow Designer Implementation Plan

## Overview

This plan implements full CRUD operations for ServiceNow Flow Designer flows using the **standard Table API** (not the undocumented Fluent SDK endpoints). This approach is more maintainable and documented.

## Architecture Understanding

From the Fluent SDK analysis, flows consist of multiple related records:

1. **Main Flow**: `sys_hub_flow` - Contains flow metadata and gzipped JSON configuration
2. **Flow Logic Instances**: `sys_hub_flow_logic_instance_v2` - If/else blocks, loops, etc.
3. **Action Instances**: `sys_hub_action_instance_v2` - Individual actions in the flow
4. **Trigger Instances**: `sys_flow_record_trigger`, `sys_flow_timer_trigger` - Flow triggers
5. **Flow Variables**: `sys_hub_flow_variable` - Flow inputs/outputs
6. **Alias Mappings**: `sys_hub_alias_mapping` - Variable mappings between actions

## Implementation Phases

### Phase 1: Basic Flow CRUD (Week 1)

**Files to Create/Modify:**

1. **internal/sdk/client.go** - Add flow CRUD methods
2. **internal/commands/flows.go** - Add create/delete/update subcommands

**SDK Methods to Add:**

```go
// CreateFlow creates a new flow with basic configuration
func (c *Client) CreateFlow(ctx context.Context, name, description, scope string, active bool) (*Flow, error)

// DeleteFlow deletes a flow and optionally its related records
func (c *Client) DeleteFlow(ctx context.Context, flowID string, cascade bool) error

// UpdateFlow updates flow properties (name, description, run_as, etc.)
func (c *Client) UpdateFlow(ctx context.Context, flowID string, updates map[string]interface{}) (*Flow, error)
```

**Commands to Add:**

```bash
jsn flows create --name "My Flow" --description "Test flow" --scope "x_myapp"
jsn flows delete <flow-id-or-name> [--cascade]
jsn flows update <flow-id-or-name> --name "New Name" --description "Updated"
```

**Implementation Details:**

- Use standard Table API POST/PUT/DELETE operations
- Generate a sys_id for new flows (use Go's uuid package or generate 32-char hex)
- Set required fields: `name`, `active`, `sys_scope`
- Handle scope resolution (convert scope name to sys_id)

### Phase 2: Flow Activation/Deactivation Enhancement (Week 1)

**Already Implemented:**
- `jsn flows activate <flow-id-or-name>`
- `jsn flows deactivate <flow-id-or-name>`

**Enhancement:** Add validation that flow is valid before activation

```go
// ValidateFlow checks if a flow has the required configuration to be activated
func (c *Client) ValidateFlow(ctx context.Context, flowID string) (valid bool, errors []string, err error)
```

### Phase 3: Flow Actions Management (Week 2)

**New SDK Methods:**

```go
// CreateFlowAction creates a new action instance in a flow
func (c *Client) CreateFlowAction(ctx context.Context, flowID string, action CreateFlowActionInput) (*FlowAction, error)

type CreateFlowActionInput struct {
    Name       string
    ActionType string      // e.g., "core.createRecord", "core.updateRecord"
    Order      int
    Inputs     map[string]interface{}  // Action configuration
}

// UpdateFlowAction updates an existing action instance
func (c *Client) UpdateFlowAction(ctx context.Context, actionID string, updates map[string]interface{}) (*FlowAction, error)

// DeleteFlowAction removes an action from a flow
func (c *Client) DeleteFlowAction(ctx context.Context, actionID string) error

// ReorderFlowActions updates the order of actions in a flow
func (c *Client) ReorderFlowActions(ctx context.Context, flowID string, actionOrders map[string]int) error
```

**New Commands:**

```bash
# List actions in a flow
jsn flows actions list <flow-id-or-name>

# Add an action to a flow
jsn flows actions add <flow-id-or-name> \
  --type "core.createRecord" \
  --name "Create Incident" \
  --order 100 \
  --input table_name=incident \
  --input short_description="Test"

# Update an action
jsn flows actions update <action-id> \
  --name "Updated Name" \
  --input priority=1

# Delete an action
jsn flows actions delete <action-id>

# Reorder actions
jsn flows actions reorder <flow-id-or-name> \
  --actions action1=100,action2=200
```

### Phase 4: Flow Logic (If/Else/Loops) (Week 2-3)

**Understanding from SDK Analysis:**

Flow logic instances use `sys_hub_flow_logic_instance_v2` table with:
- `logic_definition` field - References the type of logic (if, elseIf, else, forEach)
- `parent_ui_id` - References parent flow or logic block
- `ui_id` - Unique identifier for this logic block
- `values` - Gzipped JSON configuration

**SDK Methods:**

```go
// CreateFlowLogic creates a flow logic block (if/else/forEach)
func (c *Client) CreateFlowLogic(ctx context.Context, flowID string, logic CreateFlowLogicInput) (*FlowLogic, error)

type CreateFlowLogicInput struct {
    Type       string // "if", "elseIf", "else", "forEach"
    ParentID   string // parent flow ID or parent logic block ID
    Order      int
    Condition  string // for if/elseIf blocks
    Collection string // for forEach loops
}

// DeleteFlowLogic removes a logic block and optionally its children
func (c *Client) DeleteFlowLogic(ctx context.Context, logicID string, cascade bool) error
```

**Commands:**

```bash
# Add if block to flow
jsn flows logic add-if <flow-id> \
  --condition "current.priority == 1" \
  --order 100

# Add else-if block
jsn flows logic add-else-if <flow-id> \
  --parent <parent-if-id> \
  --condition "current.priority == 2"

# Add else block
jsn flows logic add-else <flow-id> \
  --parent <parent-if-id>

# Add forEach loop
jsn flows logic add-foreach <flow-id> \
  --collection "{{trigger.current.related_list}}" \
  --order 200

# List logic blocks
jsn flows logic list <flow-id>

# Delete logic block
jsn flows logic delete <logic-id> [--cascade]
```

### Phase 5: Flow Variables (Inputs/Outputs) (Week 3)

**SDK Methods:**

```go
// CreateFlowVariable creates a flow variable (input or output)
func (c *Client) CreateFlowVariable(ctx context.Context, flowID string, variable CreateFlowVariableInput) (*FlowVariable, error)

type CreateFlowVariableInput struct {
    Name        string
    Label       string
    Type        string // "string", "integer", "boolean", "glide_date", etc.
    Direction   string // "input", "output"
    DefaultValue string
    Mandatory   bool
    Description string
}

// UpdateFlowVariable updates an existing variable
func (c *Client) UpdateFlowVariable(ctx context.Context, variableID string, updates map[string]interface{}) (*FlowVariable, error)

// DeleteFlowVariable removes a variable
func (c *Client) DeleteFlowVariable(ctx context.Context, variableID string) error
```

**Commands:**

```bash
# List flow variables
jsn flows variables list <flow-id-or-name>

# Add input variable
jsn flows variables add <flow-id-or-name> \
  --name "employeeName" \
  --label "Employee Name" \
  --type string \
  --direction input \
  --mandatory

# Add output variable
jsn flows variables add <flow-id-or-name> \
  --name "resultId" \
  --label "Result ID" \
  --type string \
  --direction output

# Update variable
jsn flows variables update <variable-id> --label "New Label"

# Delete variable
jsn flows variables delete <variable-id>
```

### Phase 6: Advanced Features (Week 4)

**Flow Import/Export:**

```go
// ExportFlow exports a flow as update set XML
func (c *Client) ExportFlow(ctx context.Context, flowID string) (xml string, err error)

// ImportFlow imports a flow from update set XML
func (c *Client) ImportFlow(ctx context.Context, xml string, targetScope string) (*Flow, error)
```

**Commands:**

```bash
# Export flow to file
jsn flows export <flow-id-or-name> --output flow.xml

# Import flow from file
jsn flows import --file flow.xml --scope "x_myapp"
```

**Flow Templates:**

```bash
# Create flow from template
jsn flows create-from-template <template-name> \
  --name "My Flow" \
  --scope "x_myapp"

# List available templates
jsn flows templates list
```

## Technical Implementation Details

### 1. Handling Gzipped Values Field

The `sys_hub_flow.values` and related `values` fields contain gzipped JSON. Implementation:

```go
package internal/sdk

import (
    "bytes"
    "compress/gzip"
    "encoding/base64"
    "encoding/json"
)

// CompressFlowValues compresses flow configuration to gzipped base64
func CompressFlowValues(data map[string]interface{}) (string, error) {
    jsonData, err := json.Marshal(data)
    if err != nil {
        return "", err
    }
    
    var buf bytes.Buffer
    gz := gzip.NewWriter(&buf)
    if _, err := gz.Write(jsonData); err != nil {
        return "", err
    }
    if err := gz.Close(); err != nil {
        return "", err
    }
    
    return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// DecompressFlowValues decompresses gzipped base64 to flow configuration
func DecompressFlowValues(compressed string) (map[string]interface{}, error) {
    data, err := base64.StdEncoding.DecodeString(compressed)
    if err != nil {
        return nil, err
    }
    
    gz, err := gzip.NewReader(bytes.NewReader(data))
    if err != nil {
        return nil, err
    }
    defer gz.Close()
    
    var result map[string]interface{}
    if err := json.NewDecoder(gz).Decode(&result); err != nil {
        return nil, err
    }
    
    return result, nil
}
```

### 2. Parent-Child Relationships

When creating related records (actions, logic blocks), maintain proper parent references:

```go
// GenerateUIID generates a unique UI ID for flow elements
func GenerateUIID() string {
    return uuid.New().String()
}

// CreateActionWithParent creates an action with proper parent reference
func (c *Client) CreateActionWithParent(ctx context.Context, flowID, parentUIID string, action CreateFlowActionInput) (*FlowAction, error) {
    uiID := GenerateUIID()
    
    data := map[string]interface{}{
        "flow":         flowID,
        "parent_ui_id": parentUIID, // References parent flow or logic block
        "ui_id":        uiID,
        "name":         action.Name,
        "action_type":  action.ActionType,
        "order":        action.Order,
        // ... other fields
    }
    
    resp, err := c.Post(ctx, "sys_hub_action_instance_v2", data)
    // ... handle response
}
```

### 3. Action Type Definitions

Create constants for common action types from the SDK analysis:

```go
package internal/sdk

// FlowActionType represents built-in flow action types
const (
    ActionCreateRecord       = "core.createRecord"
    ActionUpdateRecord       = "core.updateRecord"
    ActionDeleteRecord       = "core.deleteRecord"
    ActionLog                = "core.log"
    ActionSendEmail          = "core.sendEmail"
    ActionSendNotification   = "core.sendNotification"
    ActionAskForApproval     = "core.askForApproval"
    ActionCreateTask         = "core.createTask"
    ActionWaitForCondition   = "core.waitForCondition"
    ActionLookUpRecord       = "core.lookUpRecord"
    // ... more from the SDK analysis
)
```

### 4. Error Handling Patterns

Use existing patterns from the codebase:

```go
// Example error handling in commands
func runFlowsCreate(cmd *cobra.Command, flags flowsCreateFlags) error {
    appCtx := appctx.FromContext(cmd.Context())
    if appCtx == nil {
        return fmt.Errorf("app not initialized")
    }
    
    if appCtx.SDK == nil {
        return output.ErrAuth("no instance configured. Run: jsn setup")
    }
    
    sdkClient := appCtx.SDK.(*sdk.Client)
    
    flow, err := sdkClient.CreateFlow(cmd.Context(), flags.name, flags.description, flags.scope, flags.active)
    if err != nil {
        return fmt.Errorf("failed to create flow: %w", err)
    }
    
    // Output success
    outputWriter := appCtx.Output.(*output.Writer)
    return outputWriter.OK(map[string]interface{}{
        "sys_id": flow.SysID,
        "name":   flow.Name,
    }, output.WithSummary(fmt.Sprintf("Created flow '%s'", flow.Name)))
}
```

### 5. Interactive Mode Support

Follow existing pattern for interactive selection:

```go
// Interactive flow creation with TUI
func runFlowsCreateInteractive(cmd *cobra.Command) error {
    // Use bubbletea for interactive prompts
    // 1. Enter flow name
    // 2. Select scope from list
    // 3. Select trigger type
    // 4. Add actions interactively
    // etc.
}
```

## Testing Strategy

1. **Unit Tests**: Mock the ServiceNow API responses
2. **Integration Tests**: Test against a dev instance (optional)
3. **Manual Testing Checklist**:
   - Create a simple flow
   - Add various action types
   - Create if/else logic
   - Activate/deactivate
   - Export and re-import
   - Delete flow and verify cleanup

## Documentation

1. Update README.md with new flow commands
2. Add examples to docs/ directory
3. Include flow creation examples in command help text

## Migration Notes

Since the existing `flows` command already has `activate` and `deactivate`, we need to:

1. Ensure backward compatibility
2. Add new subcommands: `create`, `delete`, `update`
3. Add nested subcommands: `actions`, `logic`, `variables`

## Risks and Considerations

1. **Complex Configuration**: Flows with complex configurations require gzipped JSON which is error-prone
2. **Validation**: ServiceNow validates flows on activation - we should surface these errors
3. **Scope Dependencies**: Creating flows in wrong scope can cause permission errors
4. **Version Control**: Flows have versions - consider supporting version management

## Success Criteria

- [ ] Can create a basic flow via CLI
- [ ] Can add actions to a flow
- [ ] Can add if/else logic to a flow
- [ ] Can add flow variables
- [ ] Can activate/deactivate flows (already exists)
- [ ] Can delete flows with proper cleanup
- [ ] Can export/import flows
- [ ] All commands support JSON, Markdown, and Styled output
- [ ] Interactive mode works for flow creation
- [ ] Comprehensive error messages

## Next Steps

1. Start with Phase 1 (basic CRUD) to establish patterns
2. Create a test flow manually in ServiceNow UI to understand structure
3. Export it via Table API to see exact data format
4. Implement create/delete/update methods
5. Iterate through phases 2-6

## Key ServiceNow Tables Reference

| Table | Purpose |
|-------|---------|
| `sys_hub_flow` | Main flow definitions |
| `sys_hub_flow_logic_instance_v2` | If/else/loop blocks |
| `sys_hub_action_instance_v2` | Action instances |
| `sys_hub_sub_flow_instance_v2` | Subflow calls |
| `sys_hub_flow_variable` | Flow variables |
| `sys_flow_record_trigger` | Record-based triggers |
| `sys_flow_timer_trigger` | Scheduled triggers |
| `sys_hub_alias_mapping` | Variable mappings |
| `sys_hub_trigger_instance_v2` | Flow execution history |
