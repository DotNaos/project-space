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
