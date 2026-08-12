//go:build darwin || linux

package workspacesession

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func processGroupTelemetry(ctx context.Context) (float64, int64, error) {
	groupID, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		return 0, 0, err
	}
	ps := "/bin/ps"
	if _, err := os.Stat(ps); err != nil {
		ps = "/usr/bin/ps"
	}
	commandContext, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	arguments := []string{"-o", "%cpu=,rss=", "-g", strconv.Itoa(groupID)}
	if runtime.GOOS == "linux" {
		// procps versions differ in whether they support a process-group selector.
		// Listing the bounded fields and filtering the PGID ourselves works across
		// the supported Linux distributions without confusing PGID with session ID.
		arguments = []string{"-e", "-o", "pgid=,%cpu=,rss="}
	}
	command := exec.CommandContext(commandContext, ps, arguments...)
	command.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin"}
	encoded, err := command.Output()
	if err != nil || len(encoded) > 4*1024*1024 {
		return 0, 0, fmt.Errorf("observe Workspace Runtime telemetry")
	}
	return decodeProcessGroupTelemetry(encoded, groupID, runtime.GOOS == "linux")
}

func decodeProcessGroupTelemetry(encoded []byte, groupID int, includesGroupID bool) (float64, int64, error) {
	var cpuPercent float64
	var memoryKilobytes int64
	for _, line := range strings.Split(string(encoded), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if includesGroupID {
			if len(fields) != 3 {
				return 0, 0, fmt.Errorf("decode Workspace Runtime telemetry")
			}
			observedGroupID, groupErr := strconv.Atoi(fields[0])
			if groupErr != nil {
				return 0, 0, fmt.Errorf("decode Workspace Runtime telemetry")
			}
			if observedGroupID != groupID {
				continue
			}
			fields = fields[1:]
		}
		if len(fields) != 2 {
			return 0, 0, fmt.Errorf("decode Workspace Runtime telemetry")
		}
		cpu, cpuErr := strconv.ParseFloat(fields[0], 64)
		memory, memoryErr := strconv.ParseInt(fields[1], 10, 64)
		if cpuErr != nil || memoryErr != nil || math.IsNaN(cpu) || math.IsInf(cpu, 0) || cpu < 0 || memory < 0 {
			return 0, 0, fmt.Errorf("decode Workspace Runtime telemetry")
		}
		cpuPercent += cpu
		memoryKilobytes += memory
	}
	if cpuPercent > 100 {
		cpuPercent = 100
	}
	return cpuPercent, memoryKilobytes * 1024, nil
}
