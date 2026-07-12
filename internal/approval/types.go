package approval

import "time"

const (
	PolicyVersion      = 1
	AttestationVersion = 1
	EventVersion       = 2
	HistoryVersion     = 2
	TrustRootVersion   = 1
	CheckpointVersion  = 1
)

const (
	OperationApprove = "approve"
	OperationRevoke  = "revoke"

	StateApproved                 = "approved"
	StateRevoked                  = "revoked"
	StateStale                    = "stale"
	StateInvalidTampered          = "invalid_tampered"
	StateMissingHistory           = "missing_history"
	StateReplayCheckpointMismatch = "replay_checkpoint_mismatch"
)

type Policy struct {
	Version    int     `yaml:"version"`
	Repository string  `yaml:"repository"`
	PolicyID   string  `yaml:"policyId"`
	Scopes     []Scope `yaml:"scopes"`
}

type Scope struct {
	ID          string   `yaml:"id"`
	Label       string   `yaml:"label"`
	Paths       []string `yaml:"paths"`
	Ignore      []string `yaml:"ignore,omitempty"`
	Attestation string   `yaml:"attestation"`
}

type TrustRoot struct {
	Version        int    `json:"version"`
	Repository     string `json:"repository"`
	PolicyID       string `json:"policyId"`
	PolicyDigest   string `json:"policyDigest"`
	SignerID       string `json:"signerId"`
	PublicKeyPEM   string `json:"publicKeyPem"`
	KeyFingerprint string `json:"keyFingerprint"`
}

type Payload struct {
	Version             int        `json:"version"`
	Operation           string     `json:"operation,omitempty"`
	Sequence            uint64     `json:"sequence,omitempty"`
	PreviousEventDigest string     `json:"previousEventDigest,omitempty"`
	Repository          string     `json:"repository"`
	PolicyID            string     `json:"policyId"`
	PolicyDigest        string     `json:"policyDigest"`
	ScopeID             string     `json:"scopeId"`
	ContentDigest       string     `json:"contentDigest"`
	Files               []FileHash `json:"files"`
	SignerID            string     `json:"signerId"`
	IssuedAt            time.Time  `json:"issuedAt"`
}

type FileHash struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type Attestation struct {
	Version   int     `json:"version"`
	Payload   Payload `json:"payload"`
	Signature string  `json:"signature"`
}

type History struct {
	Version int           `json:"version"`
	Events  []Attestation `json:"events"`
}

type ScopeCheckpoint struct {
	Sequence      uint64 `json:"sequence"`
	EventDigest   string `json:"eventDigest"`
	Operation     string `json:"operation"`
	ContentDigest string `json:"contentDigest"`
}

type Checkpoint struct {
	Version      int                        `json:"version"`
	Repository   string                     `json:"repository"`
	PolicyID     string                     `json:"policyId"`
	PolicyDigest string                     `json:"policyDigest"`
	SignerID     string                     `json:"signerId"`
	Scopes       map[string]ScopeCheckpoint `json:"scopes"`
}

type SignatureProvider interface {
	SignerID() (string, error)
	PublicKeyPEM() (string, error)
	SignPayload(payload []byte, reason string) ([]byte, error)
}

type ScopeStatus struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	State         string `json:"state"`
	Attestation   string `json:"attestation"`
	Reason        string `json:"reason"`
	Operation     string `json:"operation"`
	ContentDigest string `json:"contentDigest"`
	SignerID      string `json:"signerId"`
	Sequence      uint64 `json:"sequence"`
	EventDigest   string `json:"eventDigest"`
}

type Report struct {
	Version    int           `json:"version"`
	Repository string        `json:"repository"`
	PolicyID   string        `json:"policyId"`
	OK         bool          `json:"ok"`
	Scopes     []ScopeStatus `json:"scopes"`
}

type PreparedScope struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type Preparation struct {
	Version             int           `json:"version"`
	Repository          string        `json:"repository"`
	PolicyID            string        `json:"policyId"`
	PolicyDigest        string        `json:"policyDigest"`
	Scope               PreparedScope `json:"scope"`
	State               string        `json:"state"`
	ContentDigest       string        `json:"contentDigest"`
	Files               []FileHash    `json:"files"`
	SignerID            string        `json:"signerId"`
	KeyFingerprint      string        `json:"keyFingerprint"`
	NextSequence        uint64        `json:"nextSequence"`
	PreviousEventDigest string        `json:"previousEventDigest"`
	Attestation         string        `json:"attestation"`
}

type OperationResult struct {
	Version       int    `json:"version"`
	Operation     string `json:"operation"`
	Repository    string `json:"repository"`
	PolicyID      string `json:"policyId"`
	ScopeID       string `json:"scopeId"`
	State         string `json:"state"`
	ContentDigest string `json:"contentDigest"`
	SignerID      string `json:"signerId"`
	Sequence      uint64 `json:"sequence"`
	EventDigest   string `json:"eventDigest"`
	Attestation   string `json:"attestation"`
}
