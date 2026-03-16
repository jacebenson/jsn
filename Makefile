.PHONY: build test lint clean install

# Build the binary
build:
	go build -ldflags="-s -w" -o bin/jsn ./cmd/jsn/main.go

# Build for all platforms
build-all:
	mkdir -p bin
	GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/jsn-linux-amd64 ./cmd/jsn/main.go
	GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o bin/jsn-linux-arm64 ./cmd/jsn/main.go
	GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o bin/jsn-darwin-amd64 ./cmd/jsn/main.go
	GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o bin/jsn-darwin-arm64 ./cmd/jsn/main.go
	GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o bin/jsn-windows-amd64.exe ./cmd/jsn/main.go

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
