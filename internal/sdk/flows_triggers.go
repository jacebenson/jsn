package sdk

import (
	"context"
	"fmt"
	"strings"
)

// CreateRecordTriggerOptions holds options for creating a record-based trigger.
type CreateRecordTriggerOptions struct {
	FlowID    string // Flow sys_id
	Table     string // Table name (e.g., "incident")
	Operation string // "create", "update", or "create_or_update"
	Condition string // Optional encoded query condition
}

// CreateRecordTrigger creates a record-based trigger for a flow.
// This creates a sys_hub_trigger_instance_v2 record with gzip+base64 encoded trigger_inputs,
// which is the correct way to persist triggers so they appear in Flow Designer UI.
func (c *Client) CreateRecordTrigger(ctx context.Context, opts CreateRecordTriggerOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.Table == "" {
		return fmt.Errorf("table name is required")
	}

	// Map operation to trigger type
	triggerType := opts.Operation
	if triggerType == "" {
		triggerType = "record_create"
	} else if triggerType == "create" {
		triggerType = "record_create"
	} else if triggerType == "update" {
		triggerType = "record_update"
	} else if triggerType == "create_or_update" {
		triggerType = "record_create_or_update"
	}

	// Look up trigger definition ID
	triggerDefID, ok := triggerDefinitionIDs[triggerType]
	if !ok {
		return fmt.Errorf("unsupported trigger type: %s", triggerType)
	}

	// Resolve flow sys_id (may be passed as name)
	flowSysID, err := c.resolveFlowID(ctx, opts.FlowID)
	if err != nil {
		return fmt.Errorf("failed to resolve flow: %w", err)
	}

	// Use the Flow Designer GraphQL API — the same API the UI uses.
	// This handles version records, trigger_instance_v2, payload, etc. atomically.

	// Step 1: Get current user sys_id for the safe edit lock
	userSysID, err := c.getCurrentUserSysID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Step 2: Create safe edit record (Flow Designer's concurrency lock)
	safeEditResp, err := c.Post(ctx, "sys_hub_flow_safe_edit", map[string]interface{}{
		"flow": flowSysID,
		"user": userSysID,
	})
	if err != nil {
		return fmt.Errorf("failed to acquire safe edit lock: %w", err)
	}
	safeEditID := getString(safeEditResp.Result, "sys_id")

	// Step 3: Clean up safe edit record when done (regardless of success/failure)
	defer func() {
		if safeEditID != "" {
			_ = c.Delete(ctx, "sys_hub_flow_safe_edit", safeEditID)
		}
	}()

	// Step 4: Build and send GraphQL mutation to insert the trigger
	triggerName := getTriggerName(triggerType)
	condition := opts.Condition

	mutation := buildTriggerInsertMutation(flowSysID, triggerName, triggerDefID, triggerType, opts.Table, condition)

	body := map[string]interface{}{
		"variables": map[string]interface{}{},
		"query":     mutation,
	}

	result, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/graphql", body, nil)
	if err != nil {
		return fmt.Errorf("failed to execute GraphQL mutation: %w", err)
	}
	if statusCode != 200 {
		return fmt.Errorf("GraphQL request failed with status %d", statusCode)
	}

	// Check for GraphQL errors in the response
	if resultMap, ok := result.(map[string]interface{}); ok {
		if errors, hasErrors := resultMap["errors"]; hasErrors {
			if errList, ok := errors.([]interface{}); ok && len(errList) > 0 {
				if firstErr, ok := errList[0].(map[string]interface{}); ok {
					return fmt.Errorf("GraphQL error: %s", getString(firstErr, "message"))
				}
			}
		}
	}

	return nil
}

// CreateScheduledTriggerOptions holds options for creating a scheduled trigger.
type CreateScheduledTriggerOptions struct {
	FlowID   string // Flow sys_id or name
	Schedule string // "daily", "weekly", "monthly", "once", "repeat"
	Time     string // Time to run (e.g., "08:00:00")
	Day      string // For weekly: day of week ("1"-"7", 1=Mon); for monthly: day of month ("1"-"31")
	Date     string // For run once: full datetime (e.g., "2026-04-16 06:10:00")
	Repeat   string // For repeat: duration as datetime (e.g., "1970-01-05 02:00:01" = 4d 2h 1s interval)
}

// CreateScheduledTrigger creates a scheduled trigger for a flow using the GraphQL API.
// Each trigger type uses its own specific single INSERT mutation with type-specific inputs
// and parameter IDs, matching exactly what Flow Designer's UI sends.
func (c *Client) CreateScheduledTrigger(ctx context.Context, opts CreateScheduledTriggerOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.Schedule == "" {
		return fmt.Errorf("schedule type is required")
	}

	triggerDefID, ok := triggerDefinitionIDs[opts.Schedule]
	if !ok {
		return fmt.Errorf("unsupported schedule type: %s", opts.Schedule)
	}

	flowSysID, err := c.resolveFlowID(ctx, opts.FlowID)
	if err != nil {
		return fmt.Errorf("failed to resolve flow: %w", err)
	}

	// Get current user for safe edit lock
	userSysID, err := c.getCurrentUserSysID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Acquire safe edit lock
	safeEditResp, err := c.Post(ctx, "sys_hub_flow_safe_edit", map[string]interface{}{
		"flow": flowSysID,
		"user": userSysID,
	})
	if err != nil {
		return fmt.Errorf("failed to acquire safe edit lock: %w", err)
	}
	safeEditID := getString(safeEditResp.Result, "sys_id")
	defer func() {
		if safeEditID != "" {
			_ = c.Delete(ctx, "sys_hub_flow_safe_edit", safeEditID)
		}
	}()

	// Format time value as "1970-01-01 HH:MM:SS" (daily, weekly, monthly need this)
	timeValue := opts.Time
	if timeValue == "" {
		timeValue = "08:00:00"
	}
	if !strings.Contains(timeValue, " ") {
		timeValue = "1970-01-01 " + timeValue
	}

	// Build INSERT mutation — each type has its own builder with type-specific param IDs
	triggerName := getTriggerName(opts.Schedule)
	var insertMutation string

	switch opts.Schedule {
	case "daily":
		insertMutation = buildDailyTriggerInsertMutation(flowSysID, triggerName, triggerDefID, timeValue)
	case "repeat":
		if opts.Repeat == "" {
			return fmt.Errorf("repeat interval is required for repeat schedule")
		}
		insertMutation = buildRepeatTriggerInsertMutation(flowSysID, triggerName, triggerDefID, opts.Repeat)
	case "weekly":
		dayValue := opts.Day
		if dayValue == "" {
			dayValue = "2" // Default: Tuesday
		}
		insertMutation = buildWeeklyTriggerInsertMutation(flowSysID, triggerName, triggerDefID, dayValue, timeValue)
	case "monthly":
		dayValue := opts.Day
		if dayValue == "" {
			dayValue = "1" // Default: 1st of month
		}
		insertMutation = buildMonthlyTriggerInsertMutation(flowSysID, triggerName, triggerDefID, dayValue, timeValue)
	case "once":
		if opts.Date == "" {
			return fmt.Errorf("date is required for run-once schedule")
		}
		insertMutation = buildOnceTriggerInsertMutation(flowSysID, triggerName, triggerDefID, opts.Date)
	default:
		return fmt.Errorf("unsupported schedule type: %s", opts.Schedule)
	}

	body := map[string]interface{}{
		"variables": map[string]interface{}{},
		"query":     insertMutation,
	}

	result, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/graphql", body, nil)
	if err != nil {
		return fmt.Errorf("failed to execute GraphQL mutation: %w", err)
	}
	if statusCode != 200 {
		return fmt.Errorf("GraphQL request failed with status %d", statusCode)
	}

	// Check for GraphQL errors
	if resultMap, ok := result.(map[string]interface{}); ok {
		if errors, hasErrors := resultMap["errors"]; hasErrors {
			if errList, ok := errors.([]interface{}); ok && len(errList) > 0 {
				if firstErr, ok := errList[0].(map[string]interface{}); ok {
					return fmt.Errorf("GraphQL error: %s", getString(firstErr, "message"))
				}
			}
		}
	}

	return nil
}

// CreateApplicationTriggerOptions holds options for creating an application trigger.
type CreateApplicationTriggerOptions struct {
	FlowID      string // Flow sys_id or name
	Application string // "service_catalog"
}

// CreateApplicationTrigger creates an application trigger for a flow using the GraphQL API.
// Currently supports "service_catalog" triggers only.
func (c *Client) CreateApplicationTrigger(ctx context.Context, opts CreateApplicationTriggerOptions) error {
	if opts.FlowID == "" {
		return fmt.Errorf("flow ID is required")
	}
	if opts.Application == "" {
		return fmt.Errorf("application is required")
	}

	triggerDefID, ok := triggerDefinitionIDs[opts.Application]
	if !ok {
		return fmt.Errorf("unsupported application trigger: %s", opts.Application)
	}

	flowSysID, err := c.resolveFlowID(ctx, opts.FlowID)
	if err != nil {
		return fmt.Errorf("failed to resolve flow: %w", err)
	}

	// Get current user for safe edit lock
	userSysID, err := c.getCurrentUserSysID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current user: %w", err)
	}

	// Acquire safe edit lock
	safeEditResp, err := c.Post(ctx, "sys_hub_flow_safe_edit", map[string]interface{}{
		"flow": flowSysID,
		"user": userSysID,
	})
	if err != nil {
		return fmt.Errorf("failed to acquire safe edit lock: %w", err)
	}
	safeEditID := getString(safeEditResp.Result, "sys_id")
	defer func() {
		if safeEditID != "" {
			_ = c.Delete(ctx, "sys_hub_flow_safe_edit", safeEditID)
		}
	}()

	// Build and send GraphQL mutation
	triggerName := getTriggerName(opts.Application)
	mutation := buildApplicationTriggerInsertMutation(flowSysID, triggerName, triggerDefID, opts.Application)

	body := map[string]interface{}{
		"variables": map[string]interface{}{},
		"query":     mutation,
	}

	result, statusCode, err := c.RawRequest(ctx, "POST", "/api/now/graphql", body, nil)
	if err != nil {
		return fmt.Errorf("failed to execute GraphQL mutation: %w", err)
	}
	if statusCode != 200 {
		return fmt.Errorf("GraphQL request failed with status %d", statusCode)
	}

	// Check for GraphQL errors
	if resultMap, ok := result.(map[string]interface{}); ok {
		if errors, hasErrors := resultMap["errors"]; hasErrors {
			if errList, ok := errors.([]interface{}); ok && len(errList) > 0 {
				if firstErr, ok := errList[0].(map[string]interface{}); ok {
					return fmt.Errorf("GraphQL error: %s", getString(firstErr, "message"))
				}
			}
		}
	}

	return nil
}

// getTriggerName returns the display name for a trigger type.
func getTriggerName(triggerType string) string {
	switch triggerType {
	case "record_create":
		return "Created"
	case "record_update":
		return "Updated"
	case "record_create_or_update":
		return "Created or Updated"
	case "daily":
		return "Daily"
	case "weekly":
		return "Weekly"
	case "monthly":
		return "Monthly"
	case "once":
		return "Run Once"
	case "repeat":
		return "Repeat"
	case "service_catalog":
		return "Service Catalog"
	default:
		return triggerType
	}
}

// buildTriggerInsertMutation builds the GraphQL mutation string for inserting a record trigger.
// This matches the exact format used by Flow Designer's UI.
func buildTriggerInsertMutation(flowSysID, triggerName, triggerDefID, triggerType, table, condition string) string {
	// The condition value needs ^EQ appended if empty (Flow Designer convention)
	conditionValue := condition
	if conditionValue == "" {
		conditionValue = "^EQ"
	}

	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Record", triggerDefinitionId: "%s", type: "%s", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "table", label: "Table", internalType: "table_name", mandatory: true, order: 1, valueSysId: "", field_name: "table", type: "table_name", children: [], displayValue: {value: ""}, value: {value: "%s"}, parameter: {id: "cfca92e0c31322002841b63b12d3ae00", label: "Table", name: "table", type: "table_name", type_label: "Table Name", hint: "", order: 1, extended: false, mandatory: true, readonly: false, maxsize: 80, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "filter_table_source=RECORD_WATCHER_RESTRICTED,", sys_class_name: "", children: []}}, {name: "condition", label: "Condition", internalType: "conditions", mandatory: false, order: 100, valueSysId: "", field_name: "condition", type: "conditions", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "66aadea0c31322002841b63b12d3aebf", label: "Condition", name: "condition", type: "conditions", type_label: "Conditions", hint: "", order: 100, extended: false, mandatory: false, readonly: false, maxsize: 4000, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table", internal_link: "", show_ref_finder: false, local: false, attributes: "modelDependent=trigger_inputs,wants_to_add_conditions=true,", sys_class_name: "", children: []}}, {name: "run_on_extended", label: "run_on_extended", internalType: "choice", mandatory: false, order: 100, valueSysId: "", field_name: "run_on_extended", type: "choice", children: [], choiceList: [{label: "No", value: "0"}, {label: "Yes", value: "1"}], displayValue: {value: ""}, value: {value: ""}, parameter: {id: "ba5e5860c31322002841b63b12d3ae59", label: "run_on_extended", name: "run_on_extended", type: "choice", type_label: "Choice", hint: "", order: 100, extended: false, mandatory: false, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "3", table: "sys_flow_record_trigger", columnName: "run_on_extended", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "advanced=true,", sys_class_name: "", choices: [{label: "No", order: 0, value: "0"}, {label: "Yes", order: 1, value: "1"}], defaultChoices: [{label: "No", order: 1, value: "0"}, {label: "Yes", order: 2, value: "1"}], children: []}}, {name: "run_flow_in", label: "Run Flow In", internalType: "choice", mandatory: false, order: 100, valueSysId: "", field_name: "run_flow_in", type: "choice", children: [], choiceList: [{label: "Run flow in background (default)", value: "background"}, {label: "Run flow in foreground", value: "foreground"}], displayValue: {value: ""}, value: {value: ""}, parameter: {id: "6090c72977203300f5bfcfcc78106159", label: "Run Flow In", name: "run_flow_in", type: "choice", type_label: "Choice", hint: "", order: 100, extended: false, mandatory: false, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "3", table: "sys_flow_record_trigger", columnName: "run_flow_in", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "advanced=true,", sys_class_name: "", choices: [{label: "Run flow in background (default)", order: 0, value: "background"}, {label: "Run flow in foreground", order: 1, value: "foreground"}], defaultChoices: [{label: "Run flow in background (default)", order: 1, value: "background"}, {label: "Run flow in foreground", order: 2, value: "foreground"}], children: []}}], outputs: [{name: "record", value: "", displayValue: "", type: "glide_record", order: 100, label: "Record", children: [], parameter: {id: "9cca92e0c31322002841b63b12d3ae04", label: "Record", name: "record", type: "glide_record", type_label: "Record", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 32, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: true, dependent_on: "table", internal_link: "", show_ref_finder: false, local: false, attributes: "", sys_class_name: ""}}, {name: "table_name", value: "", displayValue: "", type: "table_name", order: 100, label: "Table", children: [], parameter: {id: "50ca92e0c31322002841b63b12d3ae07", label: "Table", name: "table_name", type: "table_name", type_label: "Table Name", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 80, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "", sys_class_name: ""}}, {name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "a2b0d20777133010ecf06097bd5a99f8", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "bdd236e0c32132002841b63b12d3ae88", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, triggerType, table, conditionValue)
}

// buildDailyTriggerInsertMutation builds the GraphQL mutation for inserting a daily trigger.
// Uses daily-specific parameter IDs for time input and outputs.
func buildDailyTriggerInsertMutation(flowSysID, triggerName, triggerDefID, timeValue string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Scheduled", triggerDefinitionId: "%s", type: "daily", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "time", label: "Time", internalType: "glide_time", mandatory: true, order: 1, valueSysId: "", field_name: "time", type: "glide_time", children: [], displayValue: {value: ""}, value: {value: "%s"}, parameter: {id: "3ad4edc0c32222002841b63b12d3aee5", label: "Time", name: "time", type: "glide_time", type_label: "Time", hint: "", order: 1, extended: false, mandatory: true, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "", sys_class_name: "", children: []}}], outputs: [{name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "b270dac377133010ecf06097bd5a998e", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "4d0472e0c32132002841b63b12d3ae68", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, timeValue)
}

// buildRepeatTriggerInsertMutation builds the GraphQL mutation for inserting a repeat trigger.
// Unlike other scheduled triggers, repeat triggers include the repeat duration directly in the INSERT
// (not as a separate UPDATE step). The repeat value is a glide_duration encoded as a datetime
// since epoch (e.g., "1970-01-05 12:00:00" = 4 days, 12 hours).
func buildRepeatTriggerInsertMutation(flowSysID, triggerName, triggerDefID, repeatValue string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Scheduled", triggerDefinitionId: "%s", type: "repeat", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "repeat", label: "Repeat", internalType: "glide_duration", mandatory: true, order: 100, valueSysId: "", field_name: "repeat", type: "glide_duration", children: [], displayValue: {value: ""}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "1c5f4d94c32222002841b63b12d3aeb3", label: "Repeat", name: "repeat", type: "glide_duration", type_label: "Duration", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 100, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: []}}], outputs: [{name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "0af0d20777133010ecf06097bd5a994e", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "795436e0c32132002841b63b12d3aea9", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, repeatValue)
}

// buildWeeklyTriggerInsertMutation builds the GraphQL mutation for inserting a weekly trigger.
// Includes both day_of_week and time inputs with weekly-specific parameter IDs.
func buildWeeklyTriggerInsertMutation(flowSysID, triggerName, triggerDefID, dayOfWeek, timeValue string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Scheduled", triggerDefinitionId: "%s", type: "weekly", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "day_of_week", label: "Day of Week", internalType: "day_of_week", mandatory: true, order: 10, valueSysId: "", field_name: "day_of_week", type: "day_of_week", children: [], displayValue: {value: ""}, value: {value: "%s"}, parameter: {id: "c685a104c32222002841b63b12d3aed3", label: "Day of Week", name: "day_of_week", type: "day_of_week", type_label: "Day of Week", hint: "", order: 10, extended: false, mandatory: true, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: []}}, {name: "time", label: "Time", internalType: "glide_time", mandatory: true, order: 100, valueSysId: "", field_name: "time", type: "glide_time", children: [], displayValue: {schemaless: false, schemalessValue: "", value: "%s"}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "a745a104c32222002841b63b12d3ae18", label: "Time", name: "time", type: "glide_time", type_label: "Time", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 100, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: []}}], outputs: [{name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "db405ec477133010ecf06097bd5a99d5", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "eb654de0c32132002841b63b12d3ae40", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, dayOfWeek, timeValue, timeValue)
}

// buildMonthlyTriggerInsertMutation builds the GraphQL mutation for inserting a monthly trigger.
// Includes both day_of_month and time inputs with monthly-specific parameter IDs.
func buildMonthlyTriggerInsertMutation(flowSysID, triggerName, triggerDefID, dayOfMonth, timeValue string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Scheduled", triggerDefinitionId: "%s", type: "monthly", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "day_of_month", label: "Day of Month", internalType: "integer", mandatory: true, order: 10, valueSysId: "", field_name: "day_of_month", type: "integer", children: [], displayValue: {value: ""}, value: {value: "%s"}, parameter: {id: "ab36a504c32222002841b63b12d3ae8a", label: "Day of Month", name: "day_of_month", type: "integer", type_label: "Integer", hint: "", order: 10, extended: false, mandatory: true, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,integer_type=day_of_month,", sys_class_name: "", children: []}}, {name: "time", label: "Time", internalType: "glide_time", mandatory: true, order: 100, valueSysId: "", field_name: "time", type: "glide_time", children: [], displayValue: {schemaless: false, schemalessValue: "", value: "%s"}, value: {schemaless: false, schemalessValue: "", value: "%s"}, parameter: {id: "b5d52504c32222002841b63b12d3aeaa", label: "Time", name: "time", type: "glide_time", type_label: "Time", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 100, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: []}}], outputs: [{name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "7550de4477133010ecf06097bd5a9943", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "b0b58de0c32132002841b63b12d3ae63", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, dayOfMonth, timeValue, timeValue)
}

// buildOnceTriggerInsertMutation builds the GraphQL mutation for inserting a run-once trigger.
// Note: the GraphQL type is "run_once" (not "once").
func buildOnceTriggerInsertMutation(flowSysID, triggerName, triggerDefID, dateTimeValue string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Scheduled", triggerDefinitionId: "%s", type: "run_once", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "run_in", label: "Run on", internalType: "glide_date_time", mandatory: true, order: 100, valueSysId: "", field_name: "run_in", type: "glide_date_time", children: [], displayValue: {value: ""}, value: {value: "%s"}, parameter: {id: "92afcd94c32222002841b63b12d3aee8", label: "Run on", name: "run_in", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 100, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "element_mapping_provider=com.glide.flow_design.action.data.FlowDesignVariableMapper,", sys_class_name: "", children: []}}], outputs: [{name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "eda09ec377133010ecf06097bd5a99be", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "4fd37ea0c32132002841b63b12d3ae07", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, dateTimeValue)
}

// buildApplicationTriggerInsertMutation builds the GraphQL mutation for inserting an application trigger.
// Currently supports service_catalog which outputs request_item, run_start_time, run_start_date_time, table_name.
func buildApplicationTriggerInsertMutation(flowSysID, triggerName, triggerDefID, appType string) string {
	return fmt.Sprintf(`mutation {
  global {
    snFlowDesigner {
      flow(flowPatch: {flowId: "%s", triggerInstances: {insert: [{flowSysId: "%s", name: "%s", triggerType: "Application", triggerDefinitionId: "%s", type: "%s", hasDynamicOutputs: false, metadata: "{\"predicates\":[]}", inputs: [{name: "run_flow_in", label: "Run Flow In", internalType: "choice", mandatory: false, order: 100, valueSysId: "", field_name: "run_flow_in", type: "choice", children: [], choiceList: [{label: "Run flow in background (default)", value: "background"}, {label: "Run flow in foreground", value: "foreground"}], displayValue: {value: ""}, value: {value: ""}, parameter: {id: "6090c72977203300f5bfcfcc78106159", label: "Run Flow In", name: "run_flow_in", type: "choice", type_label: "Choice", hint: "", order: 100, extended: false, mandatory: false, readonly: false, maxsize: 40, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "3", table: "sys_flow_record_trigger", columnName: "run_flow_in", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "advanced=true,", sys_class_name: "", choices: [{label: "Run flow in background (default)", order: 0, value: "background"}, {label: "Run flow in foreground", order: 1, value: "foreground"}], defaultChoices: [{label: "Run flow in background (default)", order: 1, value: "background"}, {label: "Run flow in foreground", order: 2, value: "foreground"}], children: []}}], outputs: [{name: "request_item", value: "", displayValue: "", type: "reference", order: 100, label: "Request Item", children: [], parameter: {id: "002f9851c36813002841b63b12d3ae1a", label: "Request Item", name: "request_item", type: "reference", type_label: "Reference", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 32, data_structure: "", reference: "sc_req_item", reference_display: "Requested Item", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "", sys_class_name: ""}}, {name: "table_name", value: "", displayValue: "", type: "table_name", order: 100, label: "Table", children: [], parameter: {id: "c93a1011c36813002841b63b12d3ae18", label: "Table", name: "table_name", type: "table_name", type_label: "Table Name", hint: "", order: 100, extended: false, mandatory: true, readonly: false, maxsize: 80, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "", sys_class_name: ""}}, {name: "run_start_date_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Date/Time", children: [], parameter: {id: "d131164477133010ecf06097bd5a99e7", label: "Run Start Date/Time", name: "run_start_date_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}, {name: "run_start_time", value: "", displayValue: "", type: "glide_date_time", order: 110, label: "Run Start Time UTC", children: [], parameter: {id: "9e8352a0c32132002841b63b12d3ae54", label: "Run Start Time UTC", name: "run_start_time", type: "glide_date_time", type_label: "Date/Time", hint: "", order: 110, extended: false, mandatory: false, readonly: false, maxsize: 200, data_structure: "", reference: "", reference_display: "", ref_qual: "", choiceOption: "", table: "", columnName: "", defaultValue: "", use_dependent: false, dependent_on: "", internal_link: "", show_ref_finder: false, local: false, attributes: "test_input_hidden=true,", sys_class_name: ""}}]}]}}) {
        id
        triggerInstances {
          inserts {
            sysId
            uiUniqueIdentifier
            __typename
          }
          updates
          deletes
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`, flowSysID, flowSysID, triggerName, triggerDefID, appType)
}
