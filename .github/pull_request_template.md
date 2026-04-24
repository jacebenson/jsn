## Description
<!-- Describe your changes -->

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring
- [ ] Documentation

## Checklist

### Architecture Pattern (Important!)
When adding new commands that query ServiceNow tables:
- [ ] I defined local types in the command file (not in SDK)
- [ ] I used `app.SDK.List()` directly with inline query logic
- [ ] I did NOT add domain-specific helper methods to `internal/sdk/`

**Pattern to follow:** See `internal/commands/dev/forms.go` - local types, direct `app.SDK.List()` calls, inline query building with `url.Values{}`.

**Anti-pattern to avoid:** Don't create SDK methods like `ListFormViews()`, `GetSPPage()`, etc. Keep the SDK lean with only core HTTP operations.

### General
- [ ] Tests pass (`go test ./...`)
- [ ] Code follows project style
- [ ] Changes are documented

## Testing
<!-- How did you test these changes? -->

## Related Issues
<!-- Link to related issues -->
