package codextask

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

const authorizationPath = "/api/codex/authorization"

type AuthorizationAction string

const (
	AuthorizationCancel AuthorizationAction = "cancel"
	AuthorizationStart  AuthorizationAction = "start"
	AuthorizationStatus AuthorizationAction = "status"
)

type AuthorizationState string

const (
	AuthorizationAmbiguous    AuthorizationState = "ambiguous"
	AuthorizationRequired     AuthorizationState = "authorization-required"
	AuthorizationCancelled    AuthorizationState = "cancelled"
	AuthorizationExpired      AuthorizationState = "expired"
	AuthorizationFailed       AuthorizationState = "failed"
	AuthorizationOffline      AuthorizationState = "offline"
	AuthorizationPending      AuthorizationState = "pending"
	AuthorizationReady        AuthorizationState = "ready"
	AuthorizationUnauthorized AuthorizationState = "unauthorized"
	AuthorizationUnsupported  AuthorizationState = "unsupported"
)

type AuthorizationRequest struct {
	Selector
	Action      AuthorizationAction `json:"action"`
	OperationID string              `json:"operationId"`
}

type AuthorizationResult struct {
	APIVersion      int                `json:"apiVersion"`
	DeadlineAt      string             `json:"deadlineAt,omitempty"`
	Message         string             `json:"message"`
	OperationID     string             `json:"operationId"`
	State           AuthorizationState `json:"state"`
	Target          *Target            `json:"target,omitempty"`
	UserCode        string             `json:"userCode,omitempty"`
	VerificationURL string             `json:"verificationUrl,omitempty"`
}

func (client *Client) Authorize(
	ctx context.Context,
	request AuthorizationRequest,
) (AuthorizationResult, error) {
	if err := validateAuthorizationRequest(request); err != nil {
		return AuthorizationResult{}, err
	}
	result := AuthorizationResult{}
	if _, err := client.doJSON(
		ctx,
		client.authorizationHTTPClient,
		http.MethodPost,
		authorizationPath,
		nil,
		request.OperationID,
		request,
		&result,
	); err != nil {
		return AuthorizationResult{}, err
	}
	if err := validateAuthorizationResult(result, request); err != nil {
		return AuthorizationResult{}, err
	}
	return result, nil
}

func validateAuthorizationRequest(request AuthorizationRequest) error {
	if !operationIDPattern.MatchString(request.OperationID) {
		return ErrInvalidInput
	}
	switch request.Action {
	case AuthorizationCancel, AuthorizationStart, AuthorizationStatus:
	default:
		return ErrInvalidInput
	}
	return validateSelector(request.Selector, false)
}

func validateAuthorizationResult(
	result AuthorizationResult,
	request AuthorizationRequest,
) error {
	if result.APIVersion != APIVersion ||
		result.OperationID != request.OperationID ||
		!validText(result.Message, 2_048) {
		return ErrInvalidResponse
	}
	if result.Target != nil &&
		(validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector)) {
		return ErrInvalidResponse
	}
	switch result.State {
	case AuthorizationPending:
		if result.Target == nil ||
			!regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{3,31}$`).MatchString(result.UserCode) ||
			result.VerificationURL != "https://auth.openai.com/codex/device" {
			return ErrInvalidResponse
		}
		if _, err := time.Parse(time.RFC3339, result.DeadlineAt); err != nil {
			return ErrInvalidResponse
		}
	case AuthorizationReady:
		if result.Target == nil ||
			result.DeadlineAt != "" ||
			result.UserCode != "" ||
			result.VerificationURL != "" {
			return ErrInvalidResponse
		}
	case AuthorizationAmbiguous, AuthorizationRequired, AuthorizationCancelled,
		AuthorizationExpired, AuthorizationFailed, AuthorizationOffline,
		AuthorizationUnauthorized, AuthorizationUnsupported:
		if result.DeadlineAt != "" ||
			result.UserCode != "" ||
			result.VerificationURL != "" {
			return ErrInvalidResponse
		}
	default:
		return ErrInvalidResponse
	}
	if result.VerificationURL != "" {
		parsed, err := url.Parse(result.VerificationURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host != "auth.openai.com" ||
			parsed.Path != "/codex/device" || parsed.RawQuery != "" ||
			parsed.Fragment != "" || parsed.User != nil {
			return ErrInvalidResponse
		}
	}
	return nil
}
