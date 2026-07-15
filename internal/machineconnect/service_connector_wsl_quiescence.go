package machineconnect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	wslConnectorStopTimeout        = 15 * time.Second
	wslConnectorStopPollInterval   = 50 * time.Millisecond
	maximumWSLProcessCommandLength = 64 * 1024
)

type wslConnectorProcessKind uint8

const (
	wslConnectorProcessNone wslConnectorProcessKind = iota
	wslConnectorProcessSupervisor
	wslConnectorProcessCompanion
)

type wslConnectorProcessMatcher struct {
	project      string
	companion    string
	versionsRoot string
}

func waitForWSLConnectorRuntimeStop(ctx context.Context, executable string) error {
	return waitForWSLConnectorRuntimeStopAt(
		ctx,
		executable,
		"/proc",
		wslConnectorStopTimeout,
		wslConnectorStopPollInterval,
	)
}

func waitForWSLConnectorRuntimeStopAt(
	ctx context.Context,
	executable string,
	procRoot string,
	timeout time.Duration,
	pollInterval time.Duration,
) error {
	if ctx == nil {
		return errors.New("WSL connector runtime stop context is missing")
	}
	if timeout <= 0 || pollInterval <= 0 {
		return errors.New("WSL connector runtime stop timing is invalid")
	}
	matcher, err := newWSLConnectorProcessMatcher(executable)
	if err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		running, err := matcher.running(procRoot)
		if err != nil {
			return err
		}
		if !running {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return fmt.Errorf("wait for managed WSL connector processes: %w", waitCtx.Err())
		case <-ticker.C:
		}
	}
}

func newWSLConnectorProcessMatcher(executable string) (wslConnectorProcessMatcher, error) {
	resolved, err := filepath.EvalSymlinks(filepath.Clean(executable))
	if err != nil {
		return wslConnectorProcessMatcher{}, errors.New("resolve WSL connector service executable")
	}
	if toolsRoot, managed := possibleConnectorSupervisorToolsRoot(executable); managed {
		return wslConnectorProcessMatcher{
			versionsRoot: filepath.Join(toolsRoot, connectorSupervisorVersionsDirectoryName),
		}, nil
	}
	return wslConnectorProcessMatcher{
		project:   resolved,
		companion: filepath.Join(filepath.Dir(resolved), "project-space-connector"),
	}, nil
}

func (matcher wslConnectorProcessMatcher) running(procRoot string) (bool, error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return false, errors.New("inspect WSL process table")
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.ParseUint(entry.Name(), 10, 32); err != nil {
			continue
		}
		processRoot := filepath.Join(procRoot, entry.Name())
		executable, err := os.Readlink(filepath.Join(processRoot, "exe"))
		if err != nil {
			continue
		}
		kind := matcher.match(strings.TrimSuffix(executable, " (deleted)"))
		switch kind {
		case wslConnectorProcessCompanion:
			return true, nil
		case wslConnectorProcessSupervisor:
			arguments, err := readWSLProcessArguments(filepath.Join(processRoot, "cmdline"))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return false, err
			}
			if len(arguments) >= 3 && arguments[1] == "connector" && arguments[2] == "run" {
				return true, nil
			}
		}
	}
	return false, nil
}

func (matcher wslConnectorProcessMatcher) match(executable string) wslConnectorProcessKind {
	clean := filepath.Clean(executable)
	if matcher.versionsRoot == "" {
		switch clean {
		case matcher.project:
			return wslConnectorProcessSupervisor
		case matcher.companion:
			return wslConnectorProcessCompanion
		default:
			return wslConnectorProcessNone
		}
	}
	relative, err := filepath.Rel(matcher.versionsRoot, clean)
	if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return wslConnectorProcessNone
	}
	components := strings.Split(relative, string(filepath.Separator))
	if len(components) != 2 || !managedPointerComponentPattern.MatchString(components[0]) {
		return wslConnectorProcessNone
	}
	switch components[1] {
	case "project":
		return wslConnectorProcessSupervisor
	case "project-space-connector":
		return wslConnectorProcessCompanion
	default:
		return wslConnectorProcessNone
	}
}

func readWSLProcessArguments(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, maximumWSLProcessCommandLength+1))
	if err != nil {
		return nil, errors.New("read WSL connector process arguments")
	}
	if len(body) > maximumWSLProcessCommandLength {
		return nil, errors.New("WSL connector process arguments are too large")
	}
	parts := bytes.Split(bytes.TrimSuffix(body, []byte{0}), []byte{0})
	arguments := make([]string, 0, len(parts))
	for _, part := range parts {
		arguments = append(arguments, string(part))
	}
	return arguments, nil
}
