package machineresources

import "context"

type State string

const (
	StateLive        State = "live"
	StateStale       State = "stale"
	StateOffline     State = "offline"
	StateUnsupported State = "unsupported"
	StatePartial     State = "partial"
	StateFailed      State = "failed"
)

type MetricState string

const (
	MetricAvailable   MetricState = "available"
	MetricUnsupported MetricState = "unsupported"
	MetricFailed      MetricState = "failed"
)

type Context struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}

type Metric struct {
	State              MetricState `json:"state"`
	UtilizationPercent *float64    `json:"utilizationPercent,omitempty"`
	UsedBytes          *int64      `json:"usedBytes,omitempty"`
	TotalBytes         *int64      `json:"totalBytes,omitempty"`
	Message            string      `json:"message,omitempty"`
}

type Metrics struct {
	CPU    Metric `json:"cpu"`
	Memory Metric `json:"memory"`
	Disk   Metric `json:"disk"`
	GPU    Metric `json:"gpu"`
}

type Machine struct {
	MachineID           string  `json:"machineId"`
	MachineName         string  `json:"machineName"`
	PhysicalMachineID   string  `json:"physicalMachineId,omitempty"`
	PhysicalMachineName string  `json:"physicalMachineName,omitempty"`
	Context             Context `json:"context"`
	State               State   `json:"state"`
	SampledAt           string  `json:"sampledAt,omitempty"`
	ReceivedAt          string  `json:"receivedAt,omitempty"`
	Metrics             Metrics `json:"metrics"`
}

type Result struct {
	CheckedAt string    `json:"checkedAt"`
	Machines  []Machine `json:"machines"`
}

type API interface {
	List(context.Context) (Result, error)
}
