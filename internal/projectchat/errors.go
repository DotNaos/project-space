package projectchat

import "errors"

var (
	ErrMissingThreadID      = errors.New("CODEX_THREAD_ID is required for Project Chat")
	ErrInvalidThreadID      = errors.New("CODEX_THREAD_ID is invalid")
	ErrMissingAgentName     = errors.New("a registered Codex agent name is required for Project Chat")
	ErrAgentProfileNotFound = errors.New("no Project Chat agent profile is stored for this Codex thread")
	ErrInvalidAgentName     = errors.New("the registered Codex agent name is invalid")
	ErrInvalidBaseURL       = errors.New("Project Chat URL must use HTTPS, except on the loopback interface")
	ErrMissingMachineID     = errors.New("Project Connect machine identity is unavailable")
	ErrInvalidMachineID     = errors.New("Project Connect machine identity is invalid")
	ErrMissingCredential    = errors.New("Project Connect machine authentication is unavailable")
	ErrInvalidCredential    = errors.New("Project Connect machine authentication is invalid")
	ErrInvalidMessage       = errors.New("Project Chat message must not be empty")
	ErrMessageTooLarge      = errors.New("Project Chat message is too large")
	ErrInvalidRequest       = errors.New("Project Chat request is invalid")
	ErrUnauthorized         = errors.New("Project Chat access is unauthorized")
	ErrNotRegistered        = errors.New("this Codex thread is not registered with Project Chat")
	ErrIdentityExpired      = errors.New("this Codex thread registration has expired")
	ErrContentRejected      = errors.New("Project Chat rejected the message because it may contain sensitive content")
	ErrRateLimited          = errors.New("Project Chat is temporarily rate limited")
	ErrUnavailable          = errors.New("Project Chat is unavailable")
	ErrRedirectRejected     = errors.New("Project Chat refused an HTTP redirect")
	ErrResponseTooLarge     = errors.New("Project Chat returned an oversized response")
	ErrInvalidResponse      = errors.New("Project Chat returned an invalid response")
)
