.PHONY: build test lint clean install hooks

# Version info for builds
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
DATE ?= $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build flags with version info
LDFLAGS = -s -w \
	-X github.com/jacebenson/jsn/internal/version.Version=$(VERSION) \
	-X github.com/jacebenson/jsn/internal/version.Commit=$(COMMIT) \
	-X github.com/jacebenson/jsn/internal/version.Date=$(DATE)

# Build the binary
build:
	go build -ldflags="$(LDFLAGS)" -o bin/jsn ./cmd/jsn/main.go

# Build for all platforms
build-all:
	mkdir -p bin
	GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o bin/jsn-linux-amd64 ./cmd/jsn/main.go
	GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o bin/jsn-linux-arm64 ./cmd/jsn/main.go
	GOOS=darwin GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o bin/jsn-darwin-amd64 ./cmd/jsn/main.go
	GOOS=darwin GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o bin/jsn-darwin-arm64 ./cmd/jsn/main.go
	GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o bin/jsn-windows-amd64.exe ./cmd/jsn/main.go

# Run tests
test:
	go test -v ./...

# Run linter
lint:
	golangci-lint run

# Format code
fmt:
	go fmt ./...

# Clean build artifacts
clean:
	rm -rf bin/ dist/

# Install locally
install: build
	cp bin/jsn $(GOPATH)/bin/ || cp bin/jsn ~/go/bin/ || cp bin/jsn /usr/local/bin/

# Run the CLI
run:
	go run ./cmd/jsn/main.go

# Check everything before commit
check: fmt lint test

# Install git hooks
hooks:
	@echo "Installing pre-commit hook..."
	@cp scripts/pre-commit .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✓ Pre-commit hook installed. Run 'make hooks' again to update."
