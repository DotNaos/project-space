package codextask

import (
	"errors"
	"fmt"
)

var (
	ErrConflict         = errors.New("Codex machine-task operation conflicts with an existing request")
	ErrInvalidConfig    = errors.New("Codex machine-task client configuration is invalid")
	ErrInvalidInput     = errors.New("Codex machine-task input is invalid")
	ErrInvalidResponse  = errors.New("Codex machine-task response is invalid")
	ErrNotFound         = errors.New("Codex machine task was not found")
	ErrRedirectRejected = errors.New("Codex machine-task request refused an HTTP redirect")
	ErrResponseTooLarge = errors.New("Codex machine-task response is too large")
	ErrUnauthorized     = errors.New("Codex machine-task access is unauthorized")
	ErrUnavailable      = errors.New("Codex machine-task service is unavailable")
)

type RequestError struct {
	Code       string
	StatusCode int
	cause      error
}

func (err *RequestError) Error() string {
	return fmt.Sprintf("Codex machine-task request failed with %s (HTTP %d)", err.Code, err.StatusCode)
}

func (err *RequestError) Unwrap() error { return err.cause }
