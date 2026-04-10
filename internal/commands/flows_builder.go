package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/jacebenson/jsn/internal/appctx"
	"github.com/jacebenson/jsn/internal/output"
)

// FlowBuilder helps construct flows with proper nesting and validation.
type FlowBuilder struct {
	FlowID           string
	LastLogicBlockID string
	LogicBlockStack  []string
	Variables        map[string]string // name -> type
}

// NewFlowBuilder creates a new flow builder for the given flow.
func NewFlowBuilder(flowID string) *FlowBuilder {
	return &FlowBuilder{
		FlowID:          flowID,
		Variables:       make(map[string]string),
		LogicBlockStack: []string{},
	}
}

// AddVariable registers a variable for validation.
func (fb *FlowBuilder) AddVariable(name, varType string) {
	fb.Variables[name] = varType
}

// ValidateCondition checks if a condition references valid variables.
func (fb *FlowBuilder) ValidateCondition(condition string) error {
	// Check for flow variable references
	if strings.Contains(condition, "{{flow_variable.") {
		// Extract variable name
		start := strings.Index(condition, "{{flow_variable.")
		if start != -1 {
			end := strings.Index(condition[start:], "}}")
			if end != -1 {
				varRef := condition[start+2 : start+end]
				parts := strings.Split(varRef, ".")
				if len(parts) >= 2 {
					varName := parts[1]
					if _, exists := fb.Variables[varName]; !exists {
						return fmt.Errorf("flow variable '%s' not found. Create it first with: jsn flows variables add %s --name %s --type <type>", varName, fb.FlowID, varName)
					}
				}
			}
		}
	}

	// Check for undefined function calls like dayOfWeek()
	if strings.Contains(condition, "dayOfWeek()") || strings.Contains(condition, "dayofweek()") {
		return fmt.Errorf("dayOfWeek() function not available. Create a flow variable with: jsn flows variables add %s --name day_of_week --type integer", fb.FlowID)
	}

	return nil
}

// PushLogicBlock adds a logic block to the nesting stack.
func (fb *FlowBuilder) PushLogicBlock(blockID string) {
	fb.LogicBlockStack = append(fb.LogicBlockStack, blockID)
	fb.LastLogicBlockID = blockID
}

// PopLogicBlock removes the most recent logic block from the stack.
func (fb *FlowBuilder) PopLogicBlock() {
	if len(fb.LogicBlockStack) > 0 {
		fb.LogicBlockStack = fb.LogicBlockStack[:len(fb.LogicBlockStack)-1]
		if len(fb.LogicBlockStack) > 0 {
			fb.LastLogicBlockID = fb.LogicBlockStack[len(fb.LogicBlockStack)-1]
		} else {
			fb.LastLogicBlockID = ""
		}
	}
}

// CurrentParent returns the current parent logic block ID for nesting.
func (fb *FlowBuilder) CurrentParent() string {
	if len(fb.LogicBlockStack) > 0 {
		return fb.LogicBlockStack[len(fb.LogicBlockStack)-1]
	}
	return ""
}

// GetVariablesList returns a list of variable names for suggestions.
func (fb *FlowBuilder) GetVariablesList() []string {
	vars := make([]string, 0, len(fb.Variables))
	for name := range fb.Variables {
		vars = append(vars, name)
	}
	return vars
}

// FlowVariablePill returns the pill syntax for a flow variable.
func FlowVariablePill(name string) string {
	return fmt.Sprintf("{{flow_variable.%s}}", name)
}

// RunFlowWizard runs an interactive wizard for building a complete flow.
func RunFlowWizard(ctx context.Context, flowID string) error {
	appCtx := appctx.FromContext(ctx)
	if appCtx == nil {
		return fmt.Errorf("app not initialized")
	}

	if appCtx.SDK == nil {
		return output.ErrAuth("no instance configured. Run: jsn setup")
	}

	fmt.Println()
	fmt.Println(lipgloss.NewStyle().Bold(true).Foreground(output.BrandColor).Render("🚀 Flow Builder Wizard"))
	fmt.Println()
	fmt.Println("This wizard will help you build a flow step by step.")
	fmt.Println()

	// Step 1: Add trigger
	fmt.Println(lipgloss.NewStyle().Bold(true).Render("Step 1: Add Trigger"))
	fmt.Println()

	// For now, just show what they should do
	fmt.Println("Run this command to add a trigger:")
	fmt.Printf("  jsn flows triggers add \"%s\" --type created --table incident\n", flowID)
	fmt.Println()

	// Step 2: Add variables
	fmt.Println(lipgloss.NewStyle().Bold(true).Render("Step 2: Add Flow Variables (Optional)"))
	fmt.Println()
	fmt.Println("If you need variables for conditions, create them now:")
	fmt.Printf("  jsn flows variables add \"%s\" --name day_of_week --type integer\n", flowID)
	fmt.Println()

	// Step 3: Add actions
	fmt.Println(lipgloss.NewStyle().Bold(true).Render("Step 3: Add Actions"))
	fmt.Println()
	fmt.Println("Add actions to your flow:")
	fmt.Printf("  jsn flows actions add \"%s\"\n", flowID)
	fmt.Println()

	return nil
}
