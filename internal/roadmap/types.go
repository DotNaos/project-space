package roadmap

import (
	"context"
	"errors"
	"net/http"
)

var (
	ErrInvalidConfig   = errors.New("invalid roadmap client configuration")
	ErrInvalidInput    = errors.New("invalid roadmap request")
	ErrInvalidResponse = errors.New("invalid roadmap response")
	ErrUnauthorized    = errors.New("roadmap authorization failed")
	ErrUnavailable     = errors.New("roadmap service unavailable")
)

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type NodeState string

const (
	NodeDone   NodeState = "DONE"
	NodeReady  NodeState = "READY"
	NodeActive NodeState = "ACTIVE"
	NodeWait   NodeState = "WAIT"
)

type NodeReference struct {
	Number     int    `json:"number"`
	Repository string `json:"repository"`
}

type Node struct {
	NodeReference
	Description string    `json:"description"`
	State       NodeState `json:"state"`
	Title       string    `json:"title"`
	URL         string    `json:"url,omitempty"`
}

type Issue struct {
	NodeReference
	Description string `json:"description"`
	Title       string `json:"title"`
	URL         string `json:"url,omitempty"`
}

type Edge struct {
	From      NodeReference `json:"from"`
	Satisfied bool          `json:"satisfied"`
	To        NodeReference `json:"to"`
}

type Graph struct {
	DependencyFreshness string            `json:"dependencyFreshness"`
	Edges               []Edge            `json:"edges"`
	GraphRevision       string            `json:"graphRevision"`
	Issues              []Issue           `json:"issues"`
	Nodes               []Node            `json:"nodes"`
	Paths               [][]NodeReference `json:"paths"`
	Repository          string            `json:"repository"`
}

type MutationRequest struct {
	BlockedIssueNumber    int
	BlockerIssueNumber    int
	BlockerRepository     string
	ExpectedGraphRevision string
	Repository            string
}

type API interface {
	Get(context.Context, string) (Graph, error)
	AddDependency(context.Context, MutationRequest) (Graph, error)
	RemoveDependency(context.Context, MutationRequest) (Graph, error)
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
	return "Project Space rejected the roadmap request"
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
