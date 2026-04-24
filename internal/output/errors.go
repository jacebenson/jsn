// Package output provides response formatting and error handling.
package output

import (
	"errors"
	"fmt"
)

// Error is a structured error with code, message, and optional hint.
type Error struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Hint       string `json:"hint,omitempty"`
	HTTPStatus int    `json:"-"`
	Cause      error  `json:"-"`
}

func (e *Error) Error() string {
	if e.Hint != "" {
		return fmt.Sprintf("%s: %s\nHint: %s", e.Code, e.Message, e.Hint)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error {
	return e.Cause
}

// Error codes.
const (
	CodeUsage       = "usage_error"
	CodeNotFound    = "not_found"
	CodeAuth        = "auth_error"
	CodeForbidden   = "forbidden"
	CodeRateLimit   = "rate_limited"
	CodeNetwork     = "network_error"
	CodeAPI         = "api_error"
	CodeAmbiguous   = "ambiguous"
	CodeEmptyResult = "empty_result"
)

// ErrUsage returns a usage error.
func ErrUsage(msg string) *Error {
	return &Error{Code: CodeUsage, Message: msg}
}

// ErrUsageHint returns a usage error with a hint.
func ErrUsageHint(msg, hint string) *Error {
	return &Error{Code: CodeUsage, Message: msg, Hint: hint}
}

// ErrNotFound returns a not found error.
func ErrNotFound(resource, identifier string) *Error {
	return &Error{
		Code:    CodeNotFound,
		Message: fmt.Sprintf("%s not found: %s", resource, identifier),
		Hint:    fmt.Sprintf("Check the %s exists and you have access to it.", resource),
	}
}

// ErrNotFoundHint returns a not found error with a custom hint.
func ErrNotFoundHint(resource, identifier, hint string) *Error {
	return &Error{
		Code:    CodeNotFound,
		Message: fmt.Sprintf("%s not found: %s", resource, identifier),
		Hint:    hint,
	}
}

// ErrAuth returns an authentication error.
func ErrAuth(msg string) *Error {
	return &Error{
		Code:    CodeAuth,
		Message: msg,
		Hint:    "Run: jsn auth login",
	}
}

// ErrForbidden returns a forbidden error.
func ErrForbidden(msg string) *Error {
	return &Error{
		Code:       CodeForbidden,
		Message:    msg,
		HTTPStatus: 403,
	}
}

// ErrRateLimit returns a rate limit error.
func ErrRateLimit(retryAfter int) *Error {
	return &Error{
		Code:    CodeRateLimit,
		Message: fmt.Sprintf("Rate limited. Retry after %d seconds.", retryAfter),
		Hint:    "Wait before retrying, or use pagination for large queries.",
	}
}

// ErrNetwork returns a network error.
func ErrNetwork(cause error) *Error {
	return &Error{
		Code:    CodeNetwork,
		Message: fmt.Sprintf("Network error: %v", cause),
		Hint:    "Check your internet connection and instance URL.",
		Cause:   cause,
	}
}

// ErrAPI returns an API error.
func ErrAPI(status int, msg string) *Error {
	hint := "Check the API documentation for this endpoint."
	if status >= 500 {
		hint = "The ServiceNow instance may be experiencing issues. Try again later."
	}
	return &Error{
		Code:       CodeAPI,
		Message:    fmt.Sprintf("API error (status %d): %s", status, msg),
		Hint:       hint,
		HTTPStatus: status,
	}
}

// ErrAmbiguous returns an ambiguous result error.
func ErrAmbiguous(resource string, matches []string) *Error {
	return &Error{
		Code:    CodeAmbiguous,
		Message: fmt.Sprintf("Multiple %s found matching your query", resource),
		Hint:    fmt.Sprintf("Did you mean one of: %v?", matches),
	}
}

// AsError converts any error to an *Error.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: "unknown", Message: err.Error()}
}

// IsErrorCode returns true if the error has the given code.
func IsErrorCode(err error, code string) bool {
	var e *Error
	if errors.As(err, &e) {
		return e.Code == code
	}
	return false
}
