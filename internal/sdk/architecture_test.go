package sdk_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestNoSDKHelperMethods ensures we don't add domain-specific helper methods back to the SDK.
// Commands should call app.SDK.List() directly instead of using wrapper methods.
//
// This enforces the architectural pattern where:
// - SDK (client.go) provides core HTTP methods: List, Get, Create, Update, Delete
// - Commands contain their own types and query logic inline
// - No domain-specific wrappers like ListFormViews, GetSPPage, etc. in SDK
func TestNoSDKHelperMethods(t *testing.T) {
	// Allowed methods in SDK - core HTTP operations and shared utilities
	allowedMethods := map[string]bool{
		// Core CRUD operations
		"List":           true,
		"Get":            true,
		"Create":         true,
		"Update":         true,
		"Delete":         true,
		"AggregateCount": true,

		// Context methods (used by header)
		"GetCurrentUser":        true,
		"GetCurrentApplication": true,
		"GetCurrentUpdateSet":   true,

		// Shared helpers (used by multiple commands)
		"FetchAttachments":      true,
		"FetchCatalogVariables": true,
	}

	// Patterns that indicate domain-specific helper methods (should be in commands, not SDK)
	forbiddenPatterns := []string{
		"ListForm", // e.g., ListFormViews, ListFormSections
		"ListList", // e.g., ListListViews, ListListLayouts
		"GetSP",    // e.g., GetSPPage
		"ListSP",   // e.g., ListSPPages, ListSPWidgetInstances
	}

	sdkDir := "."
	fset := token.NewFileSet()

	// Walk SDK directory
	err := filepath.Walk(sdkDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip non-Go files and test files
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		// Parse the file
		node, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			t.Logf("Warning: could not parse %s: %v", path, err)
			return nil
		}

		// Inspect all declarations
		ast.Inspect(node, func(n ast.Node) bool {
			fn, ok := n.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || len(fn.Recv.List) == 0 {
				return true
			}

			// Check if it's a method on *Client
			recvType, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
			if !ok {
				return true
			}

			ident, ok := recvType.X.(*ast.Ident)
			if !ok || ident.Name != "Client" {
				return true
			}

			methodName := fn.Name.Name

			// Skip allowed methods
			if allowedMethods[methodName] {
				return true
			}

			// Check for forbidden patterns
			for _, pattern := range forbiddenPatterns {
				if strings.Contains(methodName, pattern) {
					t.Errorf(
						"SDK file %s: method '%s' appears to be a domain-specific helper. "+
							"Move this logic to the command file and call app.SDK.List() directly. "+
							"See commands/dev/forms.go for the pattern.",
						filepath.Base(path), methodName,
					)
				}
			}

			return true
		})

		return nil
	})

	if err != nil {
		t.Fatalf("Failed to walk SDK directory: %v", err)
	}
}

// TestCommandsUseDirectSDKList ensures commands don't import domain-specific SDK types
// that would indicate they're not following the inline query pattern.
func TestCommandsUseDirectSDKList(t *testing.T) {
	commandsDir := "../commands"

	// These patterns in command files indicate proper usage
	goodPatterns := []string{
		"app.SDK.List(",
		"url.Values{}",
	}

	// These patterns in command files indicate they might be using old SDK helpers
	badPatterns := []string{
		"sdk.FormSection",
		"sdk.FormElement",
		"sdk.ListLayout",
		"sdk.ListElement",
		"sdk.SPPage",
		"sdk.SPWidgetInstance",
	}

	var filesChecked int

	err := filepath.Walk(commandsDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		filesChecked++
		contentStr := string(content)

		// Check for bad patterns (old SDK type usage)
		for _, pattern := range badPatterns {
			if strings.Contains(contentStr, pattern) {
				t.Errorf(
					"Command file %s uses SDK type '%s'. "+
						"Define local types in the command file instead. "+
						"See commands/dev/forms.go for the pattern.",
					filepath.Base(path), pattern,
				)
			}
		}

		// Log files that use good patterns (for verification)
		usesDirectList := strings.Contains(contentStr, goodPatterns[0])
		if usesDirectList {
			t.Logf("✓ %s uses direct SDK.List() calls", filepath.Base(path))
		}

		return nil
	})

	if err != nil {
		t.Fatalf("Failed to walk commands directory: %v", err)
	}

	t.Logf("Checked %d command files", filesChecked)
}
