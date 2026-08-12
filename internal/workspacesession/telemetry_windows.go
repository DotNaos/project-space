//go:build windows

package workspacesession

import (
	"context"
	"fmt"
)

func processGroupTelemetry(context.Context) (float64, int64, error) {
	return 0, 0, fmt.Errorf("Workspace Runtime process-group telemetry is unavailable on Windows")
}
