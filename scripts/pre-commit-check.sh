#!/bin/bash
# pre-commit-check.sh - Run this before committing to check architecture compliance

echo "🔍 Checking architecture patterns..."

# Check for forbidden SDK patterns
FORBIDDEN_PATTERNS=(
    "func.*Client.*ListForm"
    "func.*Client.*ListList"
    "func.*Client.*GetSP"
    "func.*Client.*ListSP"
)

ERRORS=0

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    matches=$(grep -r "$pattern" internal/sdk/*.go 2>/dev/null | grep -v "_test.go" | grep -v "^Binary")
    if [ ! -z "$matches" ]; then
        echo "❌ Found forbidden SDK pattern: $pattern"
        echo "$matches"
        ERRORS=$((ERRORS + 1))
    fi
done

# Check that commands don't import old SDK types
BAD_IMPORTS=(
    "sdk.FormSection"
    "sdk.FormElement"
    "sdk.ListLayout"
    "sdk.ListElement"
    "sdk.SPPage"
    "sdk.SPWidgetInstance"
)

for pattern in "${BAD_IMPORTS[@]}"; do
    matches=$(grep -r "$pattern" internal/commands/**/*.go 2>/dev/null)
    if [ ! -z "$matches" ]; then
        echo "❌ Command using SDK type instead of local type: $pattern"
        echo "$matches"
        ERRORS=$((ERRORS + 1))
    fi
done

# Run architecture tests
echo "🧪 Running architecture tests..."
if ! go test ./internal/sdk -run TestNoSDKHelperMethods -run TestCommandsUseDirectSDKList > /dev/null 2>&1; then
    echo "❌ Architecture tests failed"
    go test ./internal/sdk -v -run "TestNoSDKHelperMethods|TestCommandsUseDirectSDKList"
    ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -eq 0 ]; then
    echo "✅ All architecture checks passed!"
    exit 0
else
    echo ""
    echo "⚠️  Architecture violations found!"
    echo "   Remember: Commands should call app.SDK.List() directly with local types."
    echo "   See internal/commands/dev/forms.go for the correct pattern."
    exit 1
fi
