//go:build !windows

package workspacerun

import "time"

const (
	defaultRetentionMinimumAge = 24 * time.Hour
	defaultRetentionMaxBytes   = int64(1 << 30)
	maximumRetentionProofBytes = defaultRetentionMaxBytes * 16
	maximumRetentionEntries    = 100_000
)

// RetentionOptions configures the privileged Workspace Runtime archive collector.
// SourceRoot is the ordinary user's Workspace Runtime state directory. CollectorRoot
// must already exist, be private, and be owned by the collector rather than that user.
type RetentionOptions struct {
	SourceRoot    string
	CollectorRoot string
	MinimumAge    time.Duration
	MaximumBytes  int64
}

type RetentionArchiveStatus string

const (
	RetentionEligible  RetentionArchiveStatus = "eligible"
	RetentionDeferred  RetentionArchiveStatus = "deferred"
	RetentionReclaimed RetentionArchiveStatus = "reclaimed"
	RetentionInvalid   RetentionArchiveStatus = "invalid"
)

type RetentionEntry struct {
	WorkspaceID     string                 `json:"workspaceId"`
	Generation      string                 `json:"generation"`
	Archive         string                 `json:"archive"`
	GenerationProof string                 `json:"generationProof"`
	CheckedAt       string                 `json:"checkedAt"`
	Status          RetentionArchiveStatus `json:"status"`
	Bytes           int64                  `json:"bytes"`
	StateSnapshots  int                    `json:"stateSnapshots"`
	Reason          string                 `json:"reason,omitempty"`
	ReclaimedAt     string                 `json:"reclaimedAt,omitempty"`
}

type RetentionReport struct {
	SourceRoot     string           `json:"sourceRoot"`
	CollectorRoot  string           `json:"collectorRoot"`
	CheckedAt      string           `json:"checkedAt"`
	ReclaimedBytes int64            `json:"reclaimedBytes"`
	Entries        []RetentionEntry `json:"entries"`
}

type retentionIntent struct {
	Version         int                 `json:"schemaVersion"`
	WorkspaceID     string              `json:"workspaceId"`
	Generation      string              `json:"generation"`
	Archive         string              `json:"archive"`
	GenerationProof string              `json:"generationProof"`
	TreeProof       string              `json:"treeProof"`
	TombstoneProof  string              `json:"tombstoneProof"`
	CheckedAt       string              `json:"checkedAt"`
	State           string              `json:"state"`
	StageName       string              `json:"stageName"`
	Snapshots       []retentionSnapshot `json:"snapshots"`
	Bytes           int64               `json:"bytes"`
}

type retentionBoundary struct {
	Version          int    `json:"schemaVersion"`
	SourceRoot       string `json:"sourceRoot"`
	SourceProof      string `json:"sourceProof"`
	StatesProof      string `json:"statesProof"`
	GenerationsProof string `json:"generationsProof"`
	SourceUID        uint32 `json:"sourceUid"`
	CollectorRoot    string `json:"collectorRoot"`
	CollectorProof   string `json:"collectorProof"`
}

type retentionSnapshot struct {
	SourceName string `json:"sourceName"`
	StageName  string `json:"stageName"`
	Proof      string `json:"proof"`
}

type retentionReceipt struct {
	Version         int    `json:"schemaVersion"`
	WorkspaceID     string `json:"workspaceId"`
	Generation      string `json:"generation"`
	Archive         string `json:"archive"`
	GenerationProof string `json:"generationProof"`
	CheckedAt       string `json:"checkedAt"`
	ReclaimedAt     string `json:"reclaimedAt"`
	Bytes           int64  `json:"bytes"`
	StateSnapshots  int    `json:"stateSnapshots"`
}
