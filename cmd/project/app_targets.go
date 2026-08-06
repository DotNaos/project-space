package main

import (
	"fmt"
	"strings"

	"github.com/DotNaos/project-space/internal/projectvalidator"
)

func parseAppTargetSelections(values []string) ([]projectvalidator.AppTargetSelection, error) {
	selections := make([]projectvalidator.AppTargetSelection, 0, len(values))
	for _, value := range values {
		parts := strings.SplitN(value, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
			return nil, fmt.Errorf("invalid --target %q; expected <target>:<device>[,<device>...]", value)
		}
		devices := []string{}
		for _, device := range strings.Split(parts[1], ",") {
			device = strings.TrimSpace(device)
			if device == "" {
				return nil, fmt.Errorf("invalid --target %q; device names cannot be empty", value)
			}
			devices = append(devices, device)
		}
		selections = append(selections, projectvalidator.AppTargetSelection{
			Target:  strings.TrimSpace(parts[0]),
			Devices: devices,
		})
	}
	return selections, nil
}
