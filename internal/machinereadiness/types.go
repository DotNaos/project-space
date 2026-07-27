package machinereadiness

const APIVersion = 1

type State string

const (
	StateReady                 State = "ready"
	StateDegraded              State = "degraded"
	StateRepairable            State = "repairable"
	StateRepairing             State = "repairing"
	StateRepaired              State = "repaired"
	StateUnreachable           State = "unreachable"
	StateAuthorizationRequired State = "authorization-required"
	StateUnauthorized          State = "unauthorized"
	StateUnsupported           State = "unsupported"
	StateFailed                State = "failed"
	StateUncertain             State = "uncertain"
	StateAmbiguous             State = "ambiguous"
	StateManuallyBlocked       State = "manually-blocked"
	StateRollingBack           State = "rolling-back"
	StateRolledBack            State = "rolled-back"
	StateRecoveryRequired      State = "recovery-required"
)

type Selector struct {
	ConnectorID         string `json:"connectorId,omitempty"`
	PhysicalMachineID   string `json:"physicalMachineId,omitempty"`
	PhysicalMachineName string `json:"physicalMachineName,omitempty"`
}

type Check struct {
	Capabilities   []string             `json:"capabilities"`
	ConnectorID    string               `json:"connectorId"`
	ConnectorName  string               `json:"connectorName"`
	Daemon         *CodexDaemonEvidence `json:"daemon,omitempty"`
	Online         bool                 `json:"online"`
	RuntimeSource  string               `json:"runtimeSource,omitempty"`
	RuntimeVersion string               `json:"runtimeVersion,omitempty"`
	State          string               `json:"state"`
	Summary        string               `json:"summary"`
	UpdateState    string               `json:"updateState,omitempty"`
}

type CodexDaemonEvidence struct {
	AppServerVersion     string `json:"appServerVersion,omitempty"`
	Authenticated        bool   `json:"authenticated"`
	CheckedAt            string `json:"checkedAt"`
	CLIVersion           string `json:"cliVersion,omitempty"`
	Compatible           bool   `json:"compatible"`
	EnvironmentID        string `json:"environmentId,omitempty"`
	Installed            bool   `json:"installed"`
	Paired               bool   `json:"paired"`
	Reachable            bool   `json:"reachable"`
	RemoteControlEnabled bool   `json:"remoteControlEnabled"`
	RemoteControlState   string `json:"remoteControlState"`
	Running              bool   `json:"running"`
	State                string `json:"state"`
}

type CodexDaemonOperation struct {
	Evidence    CodexDaemonEvidence `json:"evidence"`
	Operation   string              `json:"operation"`
	OperationID string              `json:"operationId"`
	State       string              `json:"state"`
}

type RepairAction struct {
	ConnectorID string `json:"connectorId"`
	FromVersion string `json:"fromVersion,omitempty"`
	Kind        string `json:"kind"`
	Operation   string `json:"operation"`
	ReleaseID   string `json:"releaseId,omitempty"`
	Summary     string `json:"summary"`
	ToVersion   string `json:"toVersion,omitempty"`
}

type RepairPlan struct {
	Actions []RepairAction `json:"actions"`
	ID      string         `json:"id"`
}

type RuntimeOperation struct {
	ID          string `json:"id"`
	LastFailure *struct {
		Code              string `json:"code"`
		Message           string `json:"message"`
		RollbackAvailable bool   `json:"rollbackAvailable"`
	} `json:"lastFailure,omitempty"`
	State string `json:"state"`
}

type Result struct {
	APIVersion int     `json:"apiVersion"`
	CheckedAt  string  `json:"checkedAt"`
	Checks     []Check `json:"checks"`
	Machine    *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"machine,omitempty"`
	Message    string `json:"message"`
	NextAction struct {
		Command string `json:"command,omitempty"`
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"nextAction"`
	Operation         *RuntimeOperation `json:"operation,omitempty"`
	Plan              *RepairPlan       `json:"plan,omitempty"`
	Ready             bool              `json:"ready"`
	SelectedConnector string            `json:"selectedConnectorId,omitempty"`
	State             State             `json:"state"`
}

type FixRequest struct {
	Selector
	OperationID string `json:"operationId"`
	PlanID      string `json:"planId"`
}

type FixResult struct {
	APIVersion       int                   `json:"apiVersion"`
	DaemonOperation  *CodexDaemonOperation `json:"daemonOperation,omitempty"`
	Diagnosis        Result                `json:"diagnosis"`
	OperationID      string                `json:"operationId"`
	RuntimeOperation *RuntimeOperation     `json:"runtimeOperation,omitempty"`
	State            string                `json:"state"`
}

func (result Result) Runnable() bool {
	return result.State == StateReady || result.State == StateDegraded ||
		result.State == StateRepaired
}

func (result Result) RepairSettled() bool {
	switch result.State {
	case StateReady, StateRepaired, StateFailed, StateRolledBack,
		StateRecoveryRequired, StateManuallyBlocked, StateUnsupported,
		StateAuthorizationRequired, StateUnauthorized, StateAmbiguous:
		return true
	default:
		return false
	}
}
