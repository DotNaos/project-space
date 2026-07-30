package machinepower

const APIVersion = 1

type Selector struct {
	PhysicalMachineID   string `json:"physicalMachineId,omitempty"`
	PhysicalMachineName string `json:"physicalMachineName,omitempty"`
}

type Evidence struct {
	CheckedAt       string `json:"checkedAt"`
	Fresh           bool   `json:"fresh"`
	FirmwareVersion string `json:"firmwareVersion,omitempty"`
	JetKVMOnline    *bool  `json:"jetKvmOnline,omitempty"`
	PhysicalPower   *bool  `json:"physicalPower,omitempty"`
	Source          string `json:"source"`
}

type Dispatch struct {
	Attempted          bool `json:"attempted"`
	BrokerAcknowledged bool `json:"brokerAcknowledged"`
}

type Machine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Provider struct {
	DeviceID string `json:"deviceId"`
	Kind     string `json:"kind"`
}

type Reconciliation struct {
	State string `json:"state"`
}

type StatusResult struct {
	APIVersion     int             `json:"apiVersion"`
	Evidence       *Evidence       `json:"evidence,omitempty"`
	Machine        Machine         `json:"machine"`
	Message        string          `json:"message"`
	Provider       Provider        `json:"provider"`
	Reconciliation *Reconciliation `json:"reconciliation,omitempty"`
	State          string          `json:"state"`
}

type Request struct {
	Selector
	OperationID    string `json:"operationId"`
	RequestedState string `json:"requestedState"`
}

type OperationResult struct {
	APIVersion     int       `json:"apiVersion"`
	Dispatch       Dispatch  `json:"dispatch"`
	Evidence       *Evidence `json:"evidence,omitempty"`
	Machine        Machine   `json:"machine"`
	Message        string    `json:"message"`
	OperationID    string    `json:"operationId"`
	Provider       Provider  `json:"provider"`
	RequestedState string    `json:"requestedState"`
	State          string    `json:"state"`
}
