# Contributing to JSN

Thank you for considering a contribution! This guide will get you up and running in minutes.

## Quick Start (5 minutes)

```bash
# 1. Clone and enter the repo
git clone https://github.com/jacebenson/jsn
cd jsn

# 2. Install the pre-commit hook (recommended!)
make hooks

# 3. Build the binary
make build

# 4. Run tests
make test

# 5. Set up for development
./bin/jsn setup
```

That's it! You're ready to contribute.

### Pre-Commit Hooks

This repo includes a pre-commit hook that runs tests, linting, and formatting before allowing commits. This helps catch issues before pushing to CI.

**Install the hook:**
```bash
make hooks          # Install pre-commit hook
```

**What the hook checks:**
- `go fmt` - Code formatting
- `go vet` - Static analysis
- `go test` - Unit tests
- `golangci-lint` - Full linting (if installed)

**Bypass the hook** (in emergencies):
```bash
git commit --no-verify -m "your message"
```

**Note:** Bypassing is discouraged. The hook exists to save you time by catching issues before CI does.

---

## Development Requirements

- **Go 1.21+**
- **Make** (for convenience commands)
- A ServiceNow instance for testing (optional but recommended)

## Common Development Tasks

### Build

```bash
make build          # Build for current platform
make build-all      # Build for all platforms (Linux, macOS, Windows)
make run            # Run without building (go run)
```

### Test

```bash
make test           # Run all tests
make lint           # Run linter (requires golangci-lint)
make check          # Run fmt + lint + test (do this before PR!)
```

### Local Installation

```bash
make install        # Install to $GOPATH/bin or ~/go/bin
```

### Clean

```bash
make clean          # Remove bin/ and dist/
```

---

## Testing Your Changes

### With a Real ServiceNow Instance

1. **Set up authentication:**
   ```bash
   ./bin/jsn setup
   ```

2. **Test basic commands:**
   ```bash
   ./bin/jsn auth status
   ./bin/jsn tables list
   ./bin/jsn records --table incident --limit 5
   ```

### Without a ServiceNow Instance

You can still run tests and verify builds:

```bash
make test
make build-all
```

---

## Project Structure

```
jsn/
├── cmd/jsn/              # Main entrypoint
├── internal/
│   ├── appctx/           # Application context
│   ├── auth/             # Authentication (keyring + file fallback)
│   ├── cli/              # CLI root command setup
│   ├── commands/         # All CLI commands (auth, config, tables, etc.)
│   ├── config/           # Configuration management
│   ├── output/           # Output formatting (JSON, Markdown, styled)
│   ├── sdk/              # ServiceNow API client
│   └── tui/              # Terminal UI components
├── scripts/
│   └── install.sh        # Installation script
├── .github/workflows/    # CI/CD
├── Makefile              # Build automation
└── go.mod                # Go module definition
```

---

## Pull Request Checklist

Before submitting a PR, please:

- [ ] **Pre-commit hook installed:** `make hooks` (runs checks automatically)
- [ ] **Build passes:** `make build`
- [ ] **Tests pass:** `make test`
- [ ] **Code is formatted:** `make fmt` (or `go fmt ./...`)
- [ ] **Linter passes:** `make lint` (or `golangci-lint run`)
- [ ] **All checks pass:** `make check` (runs all of the above)

### PR Guidelines

1. **One logical change per PR** - Don't mix unrelated changes
2. **Update documentation** - If you add/change commands, update README.md
3. **Add tests** - If adding new functionality, include tests
4. **Test against a real instance** - If possible, verify with actual ServiceNow
5. **Clear commit messages** - Explain what and why, not just how

### Commit Message Format

```
type: Brief description (50 chars or less)

Optional longer explanation. Wrap at 72 chars.

- Bullet points are okay
- Use imperative mood ("Add feature" not "Added feature")
```

Types:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Test changes
- `chore:` Build/tooling changes

---

## Code Style

We follow standard Go conventions:

- Run `go fmt ./...` (enforced by CI)
- Run `go vet ./...` (enforced by CI)
- Keep functions focused and small
- Add comments for exported functions
- Handle errors explicitly (don't ignore them)

---

## Configuration for Development

During development, you can use environment variables instead of stored credentials:

```bash
export SERVICENOW_TOKEN="your_g_ck_token_here"
export SERVICENOW_URL="https://yourinstance.service-now.com"
./bin/jsn tables list
```

This is useful for testing without modifying your stored config.

---

## Questions?

- **Bug reports:** [Open an issue](https://github.com/jacebenson/jsn/issues)
- **Feature requests:** [Open an issue](https://github.com/jacebenson/jsn/issues)
- **General questions:** [Discussions](https://github.com/jacebenson/jsn/discussions)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
