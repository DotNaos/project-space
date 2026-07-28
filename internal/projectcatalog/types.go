package projectcatalog

import (
	"context"
	"errors"
	"net/http"
)

var (
	ErrInvalidConfig   = errors.New("invalid project catalog client configuration")
	ErrInvalidResponse = errors.New("invalid project catalog response")
	ErrUnauthorized    = errors.New("project catalog authorization failed")
	ErrUnavailable     = errors.New("project catalog service unavailable")
)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type Account struct {
	Login string `json:"login,omitempty"`
}

type CatalogEvidence struct {
	CacheState  string `json:"cacheState,omitempty"`
	CheckedAt   string `json:"checkedAt"`
	LastUpdated string `json:"lastUpdated,omitempty"`
	Message     string `json:"message,omitempty"`
	Status      string `json:"status"`
}

type LocalCandidate struct {
	Path      string `json:"path"`
	ProjectID string `json:"projectId"`
}

type Project struct {
	DisplayName     string           `json:"displayName"`
	ID              string           `json:"id"`
	LocalCandidates []LocalCandidate `json:"localCandidates"`
	Repository      string           `json:"repository"`
}

type Catalog struct {
	Account       Account         `json:"account"`
	Catalog       CatalogEvidence `json:"catalog"`
	Projects      []Project       `json:"projects"`
	SchemaVersion int             `json:"schemaVersion"`
}

type API interface {
	List(context.Context) (Catalog, error)
}

type APIError struct {
	Code       string
	Message    string
	StatusCode int
}

func (failure *APIError) Error() string {
	if failure.Message != "" {
		return failure.Message
	}
	return "Project Space rejected the project catalog request"
}

func (failure *APIError) Unwrap() error {
	switch {
	case failure.StatusCode == http.StatusUnauthorized ||
		failure.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case failure.StatusCode == http.StatusTooManyRequests ||
		failure.StatusCode >= http.StatusInternalServerError:
		return ErrUnavailable
	default:
		return nil
	}
}
