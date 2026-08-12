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
		arguments = []string{"-o", "%cpu=,rss=", "--pgroup", strconv.Itoa(groupID)}
	}
	command := exec.CommandContext(commandContext, ps, arguments...)
	command.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin"}
	encoded, err := command.Output()
	if err != nil || len(encoded) > 64*1024 {
		return 0, 0, fmt.Errorf("observe Workspace Runtime telemetry")
	}
	var cpuPercent float64
	var memoryKilobytes int64
	for _, line := range strings.Split(string(encoded), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
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
