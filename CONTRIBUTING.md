# Contributing to ServiceNow CLI (JSN)

## Development Setup

```bash
git clone https://github.com/ai-in-box/servicenow-cli
cd servicenow-cli
go build -o bin/jsn ./cmd/jsn    # Build the binary
```

## Requirements

- Go 1.23+
- A ServiceNow instance with a valid `g_ck` token

## Getting Started (Local Development)

### 1. Build the Binary

```bash
go build -o bin/jsn ./cmd/jsn
```

### 2. Run Interactive Setup (Recommended)

The easiest way to configure the CLI is using the interactive setup wizard:

```bash
./bin/jsn setup
```

This will guide you through:
- Entering your ServiceNow instance URL
- Creating a named profile (e.g., `dev`, `prod`)
- Authenticating with your g_ck token

### 3. Manual Configuration (Alternative)

If you prefer manual setup:

```bash
# Add a profile
./bin/jsn config add dev --url https://yourinstance.service-now.com --username admin

# Switch to your dev profile
./bin/jsn config switch dev

# Authenticate (you'll need a g_ck token)
./bin/jsn auth login
```

### 4. Get a g_ck Token

To authenticate, you need a `g_ck` (glide cookie) token from your ServiceNow instance:

1. Log into your ServiceNow instance in a browser
2. Open the browser's Developer Tools (F12)
3. Go to Application/Storage → Cookies → your instance
4. Find the cookie named `g_ck` and copy its value
5. Use it with: `./bin/jsn auth login --token <g_ck_value>`

Or let the CLI prompt you:
```bash
./bin/jsn auth login
# Enter your g_ck token when prompted
```

### 5. Test Your Setup

```bash
# List tables
./bin/jsn tables list

# Get a specific record
./bin/jsn tables get incident <sys_id>

# Check auth status
./bin/jsn auth status
```

## Environment Variables

You can also bypass stored credentials using environment variables:

```bash
export SERVICENOW_TOKEN="your_g_ck_token_here"
export SERVICENOW_URL="https://yourinstance.service-now.com"
./bin/jsn tables list
```

## Testing

### Run Unit Tests

```bash
go test ./...
```

### Run with Verbose Output

```bash
./bin/jsn tables list --verbose
```

## Project Structure

```
servicenow-cli/
├── cmd/jsn/           # Main entrypoint
├── bin/               # Compiled binaries
├── internal/
│   ├── appctx/        # Application context
│   ├── auth/          # Authentication (keyring + file fallback)
│   ├── cli/           # CLI root and setup
│   ├── commands/      # CLI command implementations
│   ├── config/        # Configuration management
│   ├── output/        # Output formatting
│   └── sdk/           # ServiceNow SDK
```

## Key Files

- `internal/config/config.go` - Config file paths (XDG compliant)
- `internal/auth/auth.go` - Authentication with keyring fallback
- `internal/commands/*.go` - Individual command implementations

## Configuration & Auth Storage

Following the [basecamp-cli](https://github.com/basecamp/basecamp-cli) pattern:

- **Config:** `~/.config/servicenow/config.json`
- **Credentials fallback:** `~/.config/servicenow/credentials.json` (keyring preferred)
- **Cache:** `~/.cache/servicenow/`

Use `SERVICENOW_NO_KEYRING=1` to force file-based credential storage.

## Code Style

- Follow standard Go conventions
- Run `go fmt ./...` before committing
- Keep commands focused and simple

## Pull Request Process

1. Build and test locally: `go build -o bin/jsn ./cmd/jsn && ./bin/jsn auth status`
2. Ensure your changes work with a real ServiceNow instance
3. Keep commits focused on one logical change
4. Update documentation if adding commands or changing behavior

## Questions?

Open an issue for questions about contributing.
