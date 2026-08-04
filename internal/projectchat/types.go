package projectchat

import (
	"context"
	"time"
)

const (
	GeneralChannel             = "general"
	DefaultReadLimit           = 100
	MaxReadLimit               = 200
	MaxMessageCharacters       = 4_000
	MaxResponseBytes     int64 = 1024 * 1024
)

type ThreadIdentityProvider interface {
	ThreadID(context.Context) (string, error)
}

type ThreadIdentityProviderFunc func(context.Context) (string, error)

func (provider ThreadIdentityProviderFunc) ThreadID(ctx context.Context) (string, error) {
	return provider(ctx)
}

type AgentProfile struct {
	DisplayName    string       `json:"displayName"`
	TaskTitle      string       `json:"taskTitle,omitempty"`
	Category       NameCategory `json:"category,omitempty"`
	ParentThreadID string       `json:"parentThreadId,omitempty"`
	RegistryClaim  bool         `json:"registryClaim,omitempty"`
}

type NameCategory string

const (
	NameCategoryMythology NameCategory = "mythology"
	NameCategoryArtist    NameCategory = "artist"
	NameCategoryScience   NameCategory = "science"
	NameCategoryDetective NameCategory = "detective"
)

type NameEntry struct {
	Name                   string       `json:"name"`
	Category               NameCategory `json:"category"`
	State                  string       `json:"state"`
	ClaimedByCurrentThread bool         `json:"claimedByCurrentThread,omitempty"`
}

type NameGroup struct {
	Category NameCategory `json:"category"`
	Names    []NameEntry  `json:"names"`
}
type NameCatalog struct {
	Groups []NameGroup `json:"groups"`
}
type NameClaim struct {
	Name           string       `json:"name"`
	DisplayName    string       `json:"displayName"`
	Category       NameCategory `json:"category"`
	ThreadID       string       `json:"threadId"`
	ParentThreadID string       `json:"parentThreadId,omitempty"`
}

type NameRegistryClient interface {
	ListNames(context.Context, string) (NameCatalog, error)
	ClaimName(context.Context, string, string, NameCategory, string) (NameClaim, error)
}

type AutomaticNameRegistryClient interface {
	ClaimAutomaticName(context.Context, string, []string) (NameClaim, error)
}

type AgentProfileProvider interface {
	AgentProfile(context.Context) (AgentProfile, error)
}

type AgentProfileProviderFunc func(context.Context) (AgentProfile, error)

func (provider AgentProfileProviderFunc) AgentProfile(ctx context.Context) (AgentProfile, error) {
	return provider(ctx)
}

type CredentialProvider interface {
	AccessToken(context.Context) (string, error)
}

type CredentialProviderFunc func(context.Context) (string, error)

func (provider CredentialProviderFunc) AccessToken(ctx context.Context) (string, error) {
	return provider(ctx)
}

type Sender struct {
	MemberID    string  `json:"memberId"`
	DisplayName string  `json:"displayName"`
	Handle      string  `json:"handle"`
	Role        string  `json:"role"`
	Origin      *Origin `json:"origin,omitempty"`
}

type Origin struct {
	ThreadID  string `json:"threadId"`
	HostID    string `json:"hostId,omitempty"`
	MachineID string `json:"machineId,omitempty"`
	TaskTitle string `json:"taskTitle,omitempty"`
}

type Message struct {
	ID        string    `json:"id"`
	ChannelID string    `json:"channelId"`
	Sequence  uint64    `json:"sequence"`
	Body      string    `json:"body"`
	Sender    Sender    `json:"sender"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type ReadResult struct {
	ChannelID      string    `json:"channelId"`
	Messages       []Message `json:"messages"`
	AfterSequence  uint64    `json:"afterSequence"`
	NextSequence   uint64    `json:"nextSequence"`
	LatestSequence uint64    `json:"latestSequence"`
	HasMore        bool      `json:"hasMore"`
}

type ClientAPI interface {
	Join(context.Context, string, AgentProfile) error
	UpdatePresence(context.Context, string, AgentProfile) error
	Send(context.Context, string, string, string, string) (Message, error)
	Read(context.Context, string, string, int) (ReadResult, error)
	Acknowledge(context.Context, string, string, uint64) error
}
