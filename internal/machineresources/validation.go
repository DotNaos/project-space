package machineresources

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

func validateResult(result Result) error {
	if _, err := time.Parse(time.RFC3339, result.CheckedAt); err != nil {
		return errors.New("machine resources backend returned an invalid check time")
	}
	for index, machine := range result.Machines {
		if err := validateMachine(machine); err != nil {
			return fmt.Errorf("machine resources backend returned invalid machine %d: %w", index+1, err)
		}
	}
	return nil
}

func validateMachine(machine Machine) error {
	if !validOpaque(machine.MachineID, 256) || strings.TrimSpace(machine.MachineName) == "" ||
		!validOpaque(machine.Context.ID, 256) {
		return errors.New("invalid identity")
	}
	switch machine.State {
	case StateLive, StateStale, StateOffline, StateUnsupported, StatePartial, StateFailed:
	default:
		return errors.New("invalid state")
	}
	for _, timestamp := range []string{machine.SampledAt, machine.ReceivedAt} {
		if timestamp != "" {
			if _, err := time.Parse(time.RFC3339, timestamp); err != nil {
				return errors.New("invalid timestamp")
			}
		}
	}
	for name, metric := range map[string]Metric{
		"cpu": machine.Metrics.CPU, "memory": machine.Metrics.Memory,
		"disk": machine.Metrics.Disk, "gpu": machine.Metrics.GPU,
	} {
		if err := validateMetric(metric); err != nil {
			return fmt.Errorf("%s metric: %w", name, err)
		}
	}
	return nil
}

func validateMetric(metric Metric) error {
	switch metric.State {
	case MetricAvailable:
	case MetricUnsupported, MetricFailed:
		if metric.UtilizationPercent != nil || metric.UsedBytes != nil || metric.TotalBytes != nil {
			return errors.New("unavailable metric contains a value")
		}
	default:
		return errors.New("invalid state")
	}
	if metric.UtilizationPercent != nil &&
		(math.IsNaN(*metric.UtilizationPercent) || math.IsInf(*metric.UtilizationPercent, 0) ||
			*metric.UtilizationPercent < 0 || *metric.UtilizationPercent > 100) {
		return errors.New("invalid utilization")
	}
	if metric.UsedBytes != nil && *metric.UsedBytes < 0 || metric.TotalBytes != nil && *metric.TotalBytes < 0 {
		return errors.New("invalid byte count")
	}
	if metric.UsedBytes != nil && metric.TotalBytes != nil && *metric.UsedBytes > *metric.TotalBytes {
		return errors.New("used bytes exceed total bytes")
	}
	return nil
}
