package projectchat

import (
	"encoding/json"
	"net/http"
	"time"
)

type sendRequest struct {
	ChannelID      string `json:"channelId"`
	Body           string `json:"body"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type joinRequest struct {
	DisplayName string `json:"displayName"`
	TaskTitle   string `json:"taskTitle,omitempty"`
}

type joinResponse struct {
	Channel struct {
		ChannelID string `json:"channelId"`
	} `json:"channel"`
	Member Sender `json:"member"`
}

type presenceRequest struct {
	State     string  `json:"state"`
	TaskTitle *string `json:"taskTitle"`
}

type sendResponse struct {
	Message Message `json:"message"`
}

type acknowledgementRequest struct {
	ChannelID       string `json:"channelId"`
	ThroughSequence uint64 `json:"throughSequence"`
}

type acknowledgementResponse struct {
	ChannelID string    `json:"channelId"`
	Sequence  uint64    `json:"sequence"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type nameClaimRequest struct {
	Name           string       `json:"name"`
	Category       NameCategory `json:"category"`
	ParentThreadID string       `json:"parentThreadId,omitempty"`
}

type automaticNameClaimRequest struct {
	ExcludedNames []string `json:"excludedNames,omitempty"`
	PreferredName string   `json:"preferredName,omitempty"`
}

type nameClaimResponse struct {
	Claim NameClaim `json:"claim"`
}

type apiErrorEnvelope struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func mapAPIError(statusCode int, body []byte) error {
	envelope := apiErrorEnvelope{}
	_ = json.Unmarshal(body, &envelope)
	switch envelope.Error.Code {
	case "name_conflict":
		return ErrNameConflict
	case "forbidden":
		return ErrNameRoleForbidden
	case "content_rejected":
		return ErrContentRejected
	case "not_member", "identity_not_registered", "member_not_found", "thread_not_registered":
		return ErrNotRegistered
	case "identity_expired", "registration_expired", "presence_expired":
		return ErrIdentityExpired
	case "unauthorized", "room_forbidden", "channel_forbidden":
		return ErrUnauthorized
	case "rate_limited":
		return ErrRateLimited
	}
	switch {
	case statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden:
		return ErrUnauthorized
	case statusCode == http.StatusNotFound:
		return ErrNotRegistered
	case statusCode == http.StatusUnprocessableEntity:
		return ErrContentRejected
	case statusCode == http.StatusTooManyRequests:
		return ErrRateLimited
	case statusCode >= http.StatusInternalServerError:
		return ErrUnavailable
	default:
		return ErrInvalidRequest
	}
}
