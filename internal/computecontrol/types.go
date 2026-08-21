package computecontrol

const APIVersion = 1

type StatusRequest struct {
	EnvironmentID string `json:"environmentId"`
	OperationID   string `json:"operationId"`
}

type AuditEvidence struct {
	ActorID                string `json:"actorId"`
	ActorKind              string `json:"actorKind"`
	Capability             string `json:"capability"`
	CompletedAt            string `json:"completedAt,omitempty"`
	GatewayID              string `json:"gatewayId"`
	Operation              string `json:"operation"`
	OperationID            string `json:"operationId"`
	Outcome                string `json:"outcome"`
	RouteClass             string `json:"routeClass"`
	RouteID                string `json:"routeId"`
	TargetEnvironmentID    string `json:"targetEnvironmentId"`
	TargetIdentityRevision string `json:"targetIdentityRevision"`
}

type StatusResult struct {
	CheckedAt              string `json:"checkedAt"`
	Operation              string `json:"operation"`
	OperationID            string `json:"operationId"`
	SchemaVersion          int    `json:"schemaVersion"`
	State                  string `json:"state"`
	TargetIdentityRevision string `json:"targetIdentityRevision"`
	Type                   string `json:"type"`
}

type ExecutionResult struct {
	Audit    AuditEvidence `json:"audit"`
	Replayed bool          `json:"replayed"`
	Result   StatusResult  `json:"result"`
}

type WorkspaceRuntimeLaunchRequest struct {
	Branch                string `json:"branch"`
	Commit                string `json:"commit"`
	EnvironmentID         string `json:"environmentId"`
	Generation            string `json:"generation"`
	ManifestDigest        string `json:"manifestDigest"`
	Mode                  string `json:"mode"`
	OperationID           string `json:"operationId"`
	Profile               string `json:"profile"`
	RuntimeVersion        string `json:"runtimeVersion"`
	WorkspaceID           string `json:"workspaceId"`
	WorktreeOwnerThreadID string `json:"worktreeOwnerThreadId,omitempty"`
}

type WorkspaceRuntimeClientLaunchRequest struct {
	Branch                 string `json:"branch"`
	Commit                 string `json:"commit"`
	EnvironmentID          string `json:"environmentId"`
	Generation             string `json:"generation"`
	HostID                 string `json:"hostId"`
	ManifestDigest         string `json:"manifestDigest"`
	Mode                   string `json:"mode"`
	OperationID            string `json:"operationId"`
	Profile                string `json:"profile"`
	RuntimeVersion         string `json:"runtimeVersion"`
	TargetIdentityRevision string `json:"targetIdentityRevision"`
	WorkspaceID            string `json:"workspaceId"`
	WorktreeOwnerThreadID  string `json:"worktreeOwnerThreadId,omitempty"`
}

type WorkspaceRuntimeClientLaunchResult struct {
	Branch                              string   `json:"branch"`
	Commit                              string   `json:"commit"`
	ControlTargetIdentityRevision       string   `json:"controlTargetIdentityRevision"`
	EnvironmentID                       string   `json:"environmentId"`
	Generation                          string   `json:"generation"`
	HostID                              string   `json:"hostId"`
	ManifestDigest                      string   `json:"manifestDigest"`
	Mode                                string   `json:"mode"`
	Operation                           string   `json:"operation"`
	OperationID                         string   `json:"operationId"`
	Profile                             string   `json:"profile"`
	RuntimeSessionCapabilities          []string `json:"runtimeSessionCapabilities"`
	RuntimeSessionEndpoint              string   `json:"runtimeSessionEndpoint"`
	RuntimeSessionExpiresAt             string   `json:"runtimeSessionExpiresAt"`
	RuntimeSessionOwnerUserID           string   `json:"runtimeSessionOwnerUserId"`
	RuntimeSessionRequestedCapabilities []string `json:"runtimeSessionRequestedCapabilities"`
	RuntimeSessionToken                 string   `json:"runtimeSessionToken"`
	RuntimeSessionVersion               string   `json:"runtimeSessionVersion"`
	RuntimeVersion                      string   `json:"runtimeVersion"`
	SourceHead                          string   `json:"sourceHead"`
	State                               string   `json:"state"`
	TargetIdentityRevision              string   `json:"targetIdentityRevision"`
	WorkspaceID                         string   `json:"workspaceId"`
	WorktreeOwnerThreadID               string   `json:"worktreeOwnerThreadId,omitempty"`
}

type WorkspaceRuntimeLaunchResult struct {
	CheckedAt      string `json:"checkedAt"`
	Generation     string `json:"generation"`
	ManifestDigest string `json:"manifestDigest"`
	Operation      string `json:"operation"`
	OperationID    string `json:"operationId"`
	SourceHead     string `json:"sourceHead"`
	State          string `json:"state"`
	WorkspaceID    string `json:"workspaceId"`
}

type WorkspaceRuntimeLaunchExecution struct {
	Replayed bool                         `json:"replayed"`
	Result   WorkspaceRuntimeLaunchResult `json:"result"`
}
