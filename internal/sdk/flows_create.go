package sdk

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// CreateFlowOptions holds options for creating a new flow.
type CreateFlowOptions struct {
	Name        string // Required: Flow name
	Type        string // "flow" or "subflow" (default: "flow")
	Description string // Optional: Flow description
	Active      bool   // Default: false
	RunAs       string // "user" or "system" (default: "user")
	Scope       string // Optional: defaults to user's current scope
}

// FlowVariableDef defines a flow input or output variable.
type FlowVariableDef struct {
	Name         string // Variable name (internal)
	Label        string // Display label
	Type         string // Variable type: string, integer, boolean, reference, etc.
	Mandatory    bool   // Whether the variable is required
	Reference    string // For reference types: the table name
	DefaultValue string // Default value
	Description  string // Variable description
}

// CreateSubflowOptions holds options for creating a new subflow.
type CreateSubflowOptions struct {
	Name        string            // Required: Subflow name
	Description string            // Optional: Subflow description
	Active      bool              // Default: false
	RunAs       string            // "user" or "system" (default: "user")
	Scope       string            // Optional: defaults to user's current scope
	Inputs      []FlowVariableDef // Input variables
	Outputs     []FlowVariableDef // Output variables
}

// buildInitialFlowPayload creates the initial empty-shell payload for a new
// flow or subflow version record. This matches the format Flow Designer expects.
func buildInitialFlowPayload(flowSysID, name, description, runAs, internalName, now string, active bool) map[string]interface{} {
	return map[string]interface{}{
		"id": flowSysID, "masterSnapshotId": "", "name": name, "updatedBy": "admin",
		"triggerInstances": []interface{}{}, "actionInstances": []interface{}{},
		"flowLogicInstances": []interface{}{}, "subFlowInstances": []interface{}{},
		"created": now, "updated": now, "deleted": false, "description": description,
		"scope": "global", "scopeDisplayName": "Global", "scopeName": "global", "scopeLogo": "",
		"scopeProtectionPolicyReadOnly": true, "isSnapshot": false, "status": "draft",
		"fLatestSnapshot": "", "active": active,
		"security": map[string]interface{}{
			"fCanRead": true, "fCanWrite": true, "fValidDelegatedDeveloperData": true,
			"fReason": "", "fDDInFlowDesigner": false, "fDDAccessScopes": "",
			"fCanCancelExecution": "not_applicable",
		},
		"protection": "", "canWriteProtection": false, "fIsMasterSnapshot": false,
		"inputs": []interface{}{}, "outputs": []interface{}{},
		"type": "flow", "annotation": "", "natlang": "", "category": "",
		"remoteTriggerSysId": "", "access": "public", "serviceCatalogCallable": false,
		"clientCallable": false, "stages": map[string]interface{}{}, "copiedFrom": "",
		"internalName": internalName, "flowCatalogVariableModelId": "",
		"flowCatalogVariables": []interface{}{}, "runAs": runAs,
		"domainName": "global", "domainId": "global", "compilerBuild": "",
		"runWithRoles":           map[string]interface{}{"value": "", "displayValue": ""},
		"allowHighSecurityRoles": false, "userHasRolesAssignedToFlow": false,
		"flowVariables": []interface{}{}, "isFlowEntitled": true,
		"nonCriticalErrors":                     []interface{}{},
		"pharmacy":                              map[string]interface{}{"pharmacyCompound": map[string]interface{}{}},
		"startingIndexOfErrorHandlingInstances": -1,
		"connectionConfigurations":              []interface{}{}, "engineVersion": 0,
		"flowPriority": "MEDIUM", "fUserCanRead": true, "isJsonSnapshot": false,
		"attributes": map[string]interface{}{}, "authoredOnReleaseVersion": 29000,
		"isSavedAsJson": false, "version": "1", "generationSource": "",
		"displayNameAfterPreview": "", "substatus": "",
	}
}

// CreateFlow creates a new flow in ServiceNow.
// This creates both the sys_hub_flow record and an initial version record.
func (c *Client) CreateFlow(ctx context.Context, opts CreateFlowOptions) (*Flow, error) {
	// Validate required fields
	if opts.Name == "" {
		return nil, fmt.Errorf("flow name is required")
	}

	// Set defaults
	flowType := opts.Type
	if flowType == "" {
		flowType = "flow"
	}
	runAs := opts.RunAs
	if runAs == "" {
		runAs = "user"
	}

	// Create the flow record
	flowData := map[string]interface{}{
		"name":                        opts.Name,
		"type":                        flowType,
		"description":                 opts.Description,
		"active":                      opts.Active,
		"run_as":                      runAs,
		"flow_priority":               "MEDIUM",
		"authored_on_release_version": "29000",
	}

	if opts.Scope != "" {
		flowData["scope"] = opts.Scope
	}

	resp, err := c.Post(ctx, "sys_hub_flow", flowData)
	if err != nil {
		return nil, fmt.Errorf("failed to create flow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create flow")
	}

	flow := flowFromRecord(resp.Result)

	// Create initial version record with type="Autosave" — this matches the format
	// that Flow Designer uses. If we leave type empty, FD ignores our version and
	// creates its own "update" version that overwrites our trigger data.
	internalName := strings.ReplaceAll(strings.ReplaceAll(strings.ToLower(opts.Name), " ", ""), "-", "")
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	initialPayload := buildInitialFlowPayload(flow.SysID, opts.Name, opts.Description, runAs, internalName, now, opts.Active)
	payloadJSON, _ := json.Marshal(initialPayload)
	versionData := map[string]interface{}{
		"flow":    flow.SysID,
		"type":    "Autosave",
		"payload": string(payloadJSON),
	}

	_, err = c.Post(ctx, "sys_hub_flow_version", versionData)
	if err != nil {
		_ = c.Delete(ctx, "sys_hub_flow", flow.SysID)
		return nil, fmt.Errorf("failed to create flow version: %w", err)
	}

	return &flow, nil
}

// CreateSubflow creates a new subflow with optional inputs and outputs.
func (c *Client) CreateSubflow(ctx context.Context, opts CreateSubflowOptions) (*Flow, error) {
	// Validate required fields
	if opts.Name == "" {
		return nil, fmt.Errorf("subflow name is required")
	}

	// Set defaults
	runAs := opts.RunAs
	if runAs == "" {
		runAs = "user"
	}

	// Create the flow record as a subflow
	flowData := map[string]interface{}{
		"name":        opts.Name,
		"type":        "subflow",
		"description": opts.Description,
		"active":      opts.Active,
		"run_as":      runAs,
	}

	if opts.Scope != "" {
		flowData["scope"] = opts.Scope
	}

	resp, err := c.Post(ctx, "sys_hub_flow", flowData)
	if err != nil {
		return nil, fmt.Errorf("failed to create subflow: %w", err)
	}

	if resp.Result == nil {
		return nil, fmt.Errorf("no response from create subflow")
	}

	flow := flowFromRecord(resp.Result)

	// Create initial version record with type="Autosave" and proper payload
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	internalName := strings.ReplaceAll(strings.ReplaceAll(strings.ToLower(opts.Name), " ", ""), "-", "")
	initialPayload := buildInitialFlowPayload(flow.SysID, opts.Name, opts.Description, runAs, internalName, now, opts.Active)
	payloadJSON, _ := json.Marshal(initialPayload)
	versionData := map[string]interface{}{
		"flow":    flow.SysID,
		"type":    "Autosave",
		"payload": string(payloadJSON),
	}

	_, err = c.Post(ctx, "sys_hub_flow_version", versionData)
	if err != nil {
		_ = c.Delete(ctx, "sys_hub_flow", flow.SysID)
		return nil, fmt.Errorf("failed to create subflow version: %w", err)
	}

	// Create input variables
	for _, input := range opts.Inputs {
		err := c.createFlowVariable(ctx, flow.SysID, input, "input")
		if err != nil {
			return nil, fmt.Errorf("failed to create input variable '%s': %w", input.Name, err)
		}
	}

	// Create output variables
	for _, output := range opts.Outputs {
		err := c.createFlowVariable(ctx, flow.SysID, output, "output")
		if err != nil {
			return nil, fmt.Errorf("failed to create output variable '%s': %w", output.Name, err)
		}
	}

	return &flow, nil
}

// createFlowVariable creates a single flow input or output variable.
func (c *Client) createFlowVariable(ctx context.Context, flowID string, def FlowVariableDef, direction string) error {
	variableData := map[string]interface{}{
		"flow":       flowID,
		"name":       def.Name,
		"label":      def.Label,
		"direction":  direction,
		"type":       def.Type,
		"mandatory":  def.Mandatory,
		"default":    def.DefaultValue,
		"attributes": def.Description,
	}

	if def.Reference != "" {
		variableData["reference"] = def.Reference
	}

	_, err := c.Post(ctx, "sys_hub_flow_input", variableData)
	if err != nil {
		// Try the alternative table name if the first fails
		_, err = c.Post(ctx, "sys_hub_flow_output", variableData)
	}
	return err
}
