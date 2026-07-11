package approval

import "time"

const (
	PolicyVersion      = 1
	AttestationVersion = 1
	TrustRootVersion   = 1
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
	Version       int        `json:"version"`
	Repository    string     `json:"repository"`
	PolicyID      string     `json:"policyId"`
	PolicyDigest  string     `json:"policyDigest"`
	ScopeID       string     `json:"scopeId"`
	ContentDigest string     `json:"contentDigest"`
	Files         []FileHash `json:"files"`
	SignerID      string     `json:"signerId"`
	IssuedAt      time.Time  `json:"issuedAt"`
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

type SignatureProvider interface {
	SignerID() (string, error)
	PublicKeyPEM() (string, error)
	SignPayload(payload []byte, reason string) ([]byte, error)
}

type ScopeStatus struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	State       string `json:"state"`
	Attestation string `json:"attestation"`
	Reason      string `json:"reason,omitempty"`
}

type Report struct {
	Repository string        `json:"repository"`
	PolicyID   string        `json:"policyId"`
	OK         bool          `json:"ok"`
	Scopes     []ScopeStatus `json:"scopes"`
}
