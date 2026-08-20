package codextask

import (
	"encoding/json"
	"fmt"
)

const APIVersion = 1
const DefaultModel = "gpt-5.6-luna"
const DefaultReasoningEffort = "high"

type ResultState string

const (
	StateAccepted  ResultState = "accepted"
	StateBlocked   ResultState = "blocked"
	StateCompleted ResultState = "completed"
	StateConfirmed ResultState = "confirmed"
	StateReady     ResultState = "ready"
	StateUncertain ResultState = "uncertain"
)

type BlockedReason string

const (
	BlockedApprovalRequired  BlockedReason = "approval_required"
	BlockedCodexStartFailed  BlockedReason = "codex_start_failed"
	BlockedConnectorRequired BlockedReason = "connector_required"
	BlockedInputRequired     BlockedReason = "input_required"
	BlockedLegacyUnbound     BlockedReason = "legacy_unbound"
	BlockedMachineNotReady   BlockedReason = "machine_not_ready"
	BlockedOffline           BlockedReason = "offline"
	BlockedStaleConnector    BlockedReason = "stale_connector"
	BlockedThreadActive      BlockedReason = "thread_active"
	BlockedUnauthorized      BlockedReason = "unauthorized"
	BlockedWorktreeFailure   BlockedReason = "worktree_failure"
)

type Selector struct {
	ConnectorID         string `json:"connectorId,omitempty"`
	EnvironmentID       string `json:"environmentId,omitempty"`
	PhysicalMachineID   string `json:"physicalMachineId,omitempty"`
	PhysicalMachineName string `json:"physicalMachineName,omitempty"`
}

type Target struct {
	Connector struct {
		Environment string `json:"environment,omitempty"`
		Generation  int64  `json:"generation"`
		ID          string `json:"id"`
		Name        string `json:"name"`
	} `json:"connector"`
	Environment *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"environment,omitempty"`
	PhysicalMachine struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"physicalMachine"`
}

type WorkerSelection struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort"`
}

type ReportingTask struct {
	Role     string `json:"role"`
	ThreadID string `json:"threadId"`
}

type TaskIdentity struct {
	Target
	Base *struct {
		Branch string `json:"branch"`
		Commit string `json:"commit"`
	} `json:"base,omitempty"`
	CanonicalTaskURL string `json:"canonicalTaskUrl"`
	Issue            struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	} `json:"issue"`
	Repository struct {
		ID            string `json:"id"`
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
	ReportingTask *ReportingTask  `json:"reportingTask,omitempty"`
	ThreadID      string          `json:"threadId"`
	Worker        WorkerSelection `json:"worker"`
	Workspace     *struct {
		Branch string `json:"branch"`
		ID     string `json:"id"`
		Path   string `json:"path,omitempty"`
	} `json:"workspace,omitempty"`
	Worktree struct {
		Branch string `json:"branch"`
		ID     string `json:"id"`
	} `json:"worktree"`
}

type StartRequest struct {
	Selector
	DryRun          bool   `json:"dryRun,omitempty"`
	Issue           int    `json:"issue"`
	Model           string `json:"model,omitempty"`
	OperationID     string `json:"operationId"`
	RepositoryID    string `json:"repositoryId,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

type StartPlan struct {
	Base struct {
		Branch string `json:"branch"`
		Commit string `json:"commit"`
	} `json:"base"`
	Environment struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"environment"`
	Issue struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	} `json:"issue"`
	Operation struct {
		ID    string      `json:"id"`
		State ResultState `json:"state"`
	} `json:"operation"`
	Repository struct {
		ID            string `json:"id"`
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
	ReportingTask ReportingTask `json:"reportingTask"`
	Workspace     struct {
		Branch string `json:"branch"`
		Commit string `json:"commit"`
		ID     string `json:"id"`
		Path   string `json:"path,omitempty"`
	} `json:"workspace"`
	Worktree *struct {
		Branch string `json:"branch"`
		ID     string `json:"id"`
	} `json:"worktree,omitempty"`
	Worker WorkerSelection `json:"worker"`
}

type StartResult struct {
	APIVersion  int           `json:"apiVersion"`
	Message     string        `json:"message,omitempty"`
	OperationID string        `json:"operationId"`
	Reason      BlockedReason `json:"reason,omitempty"`
	Reconcile   string        `json:"reconcile,omitempty"`
	State       ResultState   `json:"state"`
	Plan        *StartPlan    `json:"plan,omitempty"`
	Target      *Target       `json:"target,omitempty"`
	Task        *TaskIdentity `json:"task,omitempty"`
}

type ReadRequest struct {
	Selector
	Last     int    `json:"last,omitempty"`
	ThreadID string `json:"threadId"`
}

type SessionRecord struct {
	Attention            string `json:"attention,omitempty"`
	Archived             bool   `json:"archived"`
	CWD                  string `json:"cwd,omitempty"`
	ID                   string `json:"id"`
	LastActivityAt       string `json:"lastActivityAt"`
	LoadedByProjectSpace bool   `json:"loadedByProjectSpace"`
	MachineID            string `json:"machineId"`
	MachineName          string `json:"machineName"`
	Model                string `json:"model,omitempty"`
	ModelProvider        string `json:"modelProvider,omitempty"`
	Project              string `json:"project,omitempty"`
	Source               string `json:"source,omitempty"`
	Status               string `json:"status"`
	Title                string `json:"title"`
}

type ConversationItem struct {
	Detail string `json:"detail,omitempty"`
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Status string `json:"status,omitempty"`
	Text   string `json:"text,omitempty"`
}

type ConversationTurn struct {
	CompletedAt string             `json:"completedAt,omitempty"`
	ID          string             `json:"id"`
	Items       []ConversationItem `json:"items"`
	StartedAt   string             `json:"startedAt,omitempty"`
	Status      string             `json:"status"`
}

type SessionReadResult struct {
	OpenedReadOnly bool               `json:"openedReadOnly"`
	Session        SessionRecord      `json:"session"`
	StreamCursor   *uint64            `json:"streamCursor,omitempty"`
	Turns          []ConversationTurn `json:"turns"`
}

type ReadResult struct {
	APIVersion int                `json:"apiVersion"`
	Message    string             `json:"message,omitempty"`
	Reason     BlockedReason      `json:"reason,omitempty"`
	Result     *SessionReadResult `json:"result,omitempty"`
	State      ResultState        `json:"state"`
	Target     *Target            `json:"target,omitempty"`
}

type SendRequest struct {
	ReadRequest
	Message     string `json:"message"`
	OperationID string `json:"operationId"`
	Wait        bool   `json:"wait,omitempty"`
}

type SendResult struct {
	APIVersion  int                `json:"apiVersion"`
	Message     string             `json:"message,omitempty"`
	OperationID string             `json:"operationId"`
	Reason      BlockedReason      `json:"reason,omitempty"`
	Reconcile   string             `json:"reconcile,omitempty"`
	Result      *SessionReadResult `json:"result,omitempty"`
	State       ResultState        `json:"state"`
	Target      *Target            `json:"target,omitempty"`
	ThreadID    string             `json:"threadId,omitempty"`
	TurnID      string             `json:"turnId,omitempty"`
}

type SessionStreamEvent struct {
	ApprovalID        string              `json:"approvalId,omitempty"`
	CanAllow          *bool               `json:"canAllow,omitempty"`
	Command           string              `json:"command,omitempty"`
	Delta             string              `json:"delta,omitempty"`
	EventID           string              `json:"eventId"`
	Item              json.RawMessage     `json:"item,omitempty"`
	ItemID            string              `json:"itemId,omitempty"`
	Kind              string              `json:"kind,omitempty"`
	PermissionSummary []string            `json:"permissionSummary,omitempty"`
	Questions         []UserInputQuestion `json:"questions,omitempty"`
	Reason            string              `json:"reason,omitempty"`
	RequestID         string              `json:"requestId,omitempty"`
	Status            string              `json:"status,omitempty"`
	TurnID            string              `json:"turnId,omitempty"`
	Type              string              `json:"type"`
	Raw               json.RawMessage     `json:"-"`
}

type UserInputQuestion struct {
	Choices []UserInputChoice `json:"choices,omitempty"`
	ID      string            `json:"id"`
	Prompt  string            `json:"prompt"`
}

type UserInputChoice struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type ProgressEvent struct {
	APIVersion int                 `json:"apiVersion,omitempty"`
	Event      *SessionStreamEvent `json:"event,omitempty"`
	Result     *SendResult         `json:"result,omitempty"`
	Sequence   *uint64             `json:"sequence,omitempty"`
	Type       string              `json:"type"`
}

type AttachRequest struct {
	ReadRequest
	OperationID string `json:"operationId"`
}

type AttachResult struct {
	APIVersion               int           `json:"apiVersion"`
	EndpointPath             string        `json:"endpointPath,omitempty"`
	ExpiresAt                string        `json:"expiresAt,omitempty"`
	Message                  string        `json:"message,omitempty"`
	OperationID              string        `json:"operationId"`
	Reason                   BlockedReason `json:"reason,omitempty"`
	SocketPath               string        `json:"socketPath,omitempty"`
	State                    ResultState   `json:"state"`
	Target                   *Target       `json:"target,omitempty"`
	ThreadID                 string        `json:"threadId,omitempty"`
	TokenEnvironmentVariable string        `json:"tokenEnvironmentVariable,omitempty"`
	Transport                string        `json:"transport,omitempty"`
	Token                    string        `json:"-"`
	RemoteURL                string        `json:"-"`
}

func (result AttachResult) String() string {
	return fmt.Sprintf("codextask.AttachResult{State:%q, ThreadID:%q, Token:[redacted]}", result.State, result.ThreadID)
}

func (result AttachResult) GoString() string { return result.String() }
