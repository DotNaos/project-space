package projectrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const TmuxRuntimeCommandName = "__runtime-tmux"

type TmuxSessionSpec struct {
	Name              string
	ServerID          string
	RepositoryPath    string
	WorktreePath      string
	ServerKey         string
	Generation        string
	OwnershipToken    string
	WorkspaceID       string
	RuntimeGeneration string
	Mode              ServeMode
	APIs              APIsMode
	Data              DataMode
	LocalPort         int
	PublicPort        int
}

type TmuxObservation struct {
	Exists  bool
	Dead    bool
	Spec    TmuxSessionSpec
	Process ProcessRef
}

type TmuxManager interface {
	Create(context.Context, TmuxSessionSpec, Command, string, string) (TmuxObservation, error)
	Inspect(context.Context, string) (TmuxObservation, error)
	Stop(context.Context, TmuxSessionSpec) error
}

type TmuxCLI struct {
	Executable        string
	ProjectExecutable string
	Run               func(context.Context, string, ...string) (string, error)
}

func (tmux TmuxCLI) Create(
	ctx context.Context,
	spec TmuxSessionSpec,
	command Command,
	requestPath string,
	logPath string,
) (TmuxObservation, error) {
	if existing, err := tmux.Inspect(ctx, spec.Name); err != nil {
		return TmuxObservation{}, err
	} else if existing.Exists {
		return existing, fmt.Errorf("tmux session %q already exists", spec.Name)
	}
	if err := writeRuntimeRequestFile(requestPath, command); err != nil {
		return TmuxObservation{}, err
	}
	projectExecutable := tmux.ProjectExecutable
	if projectExecutable == "" {
		var err error
		projectExecutable, err = os.Executable()
		if err != nil {
			_ = os.Remove(requestPath)
			return TmuxObservation{}, fmt.Errorf("resolve Project CLI executable: %w", err)
		}
	}
	paneTarget, err := tmux.output(
		ctx, "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", spec.Name, "-c", spec.WorktreePath,
		"sleep", "86400",
	)
	if err != nil {
		_ = os.Remove(requestPath)
		return TmuxObservation{}, fmt.Errorf("create tmux session %q: %w", spec.Name, err)
	}
	created := true
	defer func() {
		if created {
			_, _ = tmux.output(context.Background(), "kill-session", "-t", spec.Name)
			_ = os.Remove(requestPath)
		}
	}()
	paneTarget = strings.TrimSpace(paneTarget)
	if !strings.HasPrefix(paneTarget, "%") {
		return TmuxObservation{}, fmt.Errorf("create tmux session %q: tmux did not return a pane identifier", spec.Name)
	}
	for key, value := range tmuxOptions(spec) {
		if _, err := tmux.output(ctx, "set-option", "-t", spec.Name, key, value); err != nil {
			return TmuxObservation{}, fmt.Errorf("record tmux ownership %s: %w", key, err)
		}
	}
	if _, err := tmux.output(
		ctx, "set-window-option", "-t", paneTarget, "remain-on-exit", "on",
	); err != nil {
		return TmuxObservation{}, fmt.Errorf("configure tmux failure retention: %w", err)
	}
	if _, err := tmux.output(
		ctx,
		"respawn-pane", "-k", "-t", paneTarget,
		projectExecutable, TmuxRuntimeCommandName, requestPath, logPath,
	); err != nil {
		return TmuxObservation{}, fmt.Errorf("start managed command in tmux session %q: %w", spec.Name, err)
	}
	observation, err := tmux.Inspect(ctx, spec.Name)
	if err != nil {
		return TmuxObservation{}, err
	}
	if !observation.Exists || !sameTmuxOwnership(observation.Spec, spec) {
		return TmuxObservation{}, fmt.Errorf("tmux session %q did not retain its ownership metadata", spec.Name)
	}
	if observation.Dead {
		return TmuxObservation{}, fmt.Errorf("managed tmux pane exited during startup")
	}
	created = false
	return observation, nil
}

func (tmux TmuxCLI) Inspect(ctx context.Context, name string) (TmuxObservation, error) {
	exists, err := tmux.hasSession(ctx, name)
	if err != nil || !exists {
		return TmuxObservation{Exists: exists}, err
	}
	format := strings.Join([]string{
		"#{session_name}", "#{pane_pid}", "#{pane_dead}",
		"#{@project-serve-server-id}", "#{@project-serve-repository}",
		"#{@project-serve-worktree}", "#{@project-serve-server-key}",
		"#{@project-serve-generation}", "#{@project-serve-token}",
		"#{@project-serve-workspace-id}", "#{@project-serve-runtime-generation}",
		"#{@project-serve-mode}", "#{@project-serve-apis}",
		"#{@project-serve-data}", "#{@project-serve-local-port}",
		"#{@project-serve-public-port}",
	}, "\t")
	body, err := tmux.output(ctx, "display-message", "-p", "-t", name, format)
	if err != nil {
		return TmuxObservation{}, fmt.Errorf("inspect tmux session %q: %w", name, err)
	}
	// Keep the final empty field for local-only sessions, which deliberately
	// have no public port. Trimming all whitespace would remove the trailing
	// tab and make a valid observation look malformed.
	fields := strings.Split(strings.TrimSuffix(body, "\n"), "\t")
	if len(fields) != 16 {
		return TmuxObservation{}, fmt.Errorf("inspect tmux session %q: expected 16 ownership fields, got %d", name, len(fields))
	}
	apis, data := normalizeTmuxBindings(APIsMode(fields[12]), DataMode(fields[13]))
	pid, _ := strconv.Atoi(fields[1])
	localPort, _ := strconv.Atoi(fields[14])
	publicPort, _ := strconv.Atoi(fields[15])
	observation := TmuxObservation{
		Exists: true,
		Dead:   fields[2] == "1",
		Spec: TmuxSessionSpec{
			Name: fields[0], ServerID: fields[3], RepositoryPath: fields[4], WorktreePath: fields[5],
			ServerKey: fields[6], Generation: fields[7], OwnershipToken: fields[8],
			WorkspaceID: fields[9], RuntimeGeneration: fields[10], Mode: ServeMode(fields[11]),
			APIs: APIsMode(apis), Data: DataMode(data),
			LocalPort: localPort, PublicPort: publicPort,
		},
	}
	if pid > 0 && !observation.Dead {
		identity, identityErr := readProcessIdentity(pid)
		if identityErr != nil {
			return TmuxObservation{}, fmt.Errorf("inspect tmux pane process %d: %w", pid, identityErr)
		}
		observation.Process = ProcessRef{PID: pid, Identity: identity}
	}
	return observation, nil
}

func (tmux TmuxCLI) Stop(ctx context.Context, expected TmuxSessionSpec) error {
	observation, err := tmux.Inspect(ctx, expected.Name)
	if err != nil {
		return err
	}
	if !observation.Exists {
		return nil
	}
	if !sameTmuxOwnership(observation.Spec, expected) {
		return fmt.Errorf("refusing to stop tmux session %q because its ownership metadata changed", expected.Name)
	}
	if _, err := tmux.output(ctx, "kill-session", "-t", expected.Name); err != nil {
		return fmt.Errorf("stop tmux session %q: %w", expected.Name, err)
	}
	if observation, err := tmux.Inspect(ctx, expected.Name); err != nil {
		return err
	} else if observation.Exists {
		return fmt.Errorf("tmux session %q still exists after stop", expected.Name)
	}
	return nil
}

func (tmux TmuxCLI) hasSession(ctx context.Context, name string) (bool, error) {
	executable := tmux.Executable
	if executable == "" {
		var err error
		executable, err = exec.LookPath("tmux")
		if err != nil {
			return false, fmt.Errorf("tmux is required for managed project servers: %w", err)
		}
	}
	command := exec.CommandContext(ctx, executable, "has-session", "-t", name)
	command.Env = safeEnvironment(os.Environ())
	err := command.Run()
	if err == nil {
		return true, nil
	}
	exitError := &exec.ExitError{}
	if errors.As(err, &exitError) && exitError.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("inspect tmux session %q: %w", name, err)
}

func (tmux TmuxCLI) output(ctx context.Context, args ...string) (string, error) {
	name := tmux.Executable
	if name == "" {
		name = "tmux"
	}
	if tmux.Run != nil {
		return tmux.Run(ctx, name, args...)
	}
	return runOutput(ctx, name, args...)
}

func tmuxOptions(spec TmuxSessionSpec) map[string]string {
	return map[string]string{
		"@project-serve-server-id":          spec.ServerID,
		"@project-serve-repository":         spec.RepositoryPath,
		"@project-serve-worktree":           spec.WorktreePath,
		"@project-serve-server-key":         spec.ServerKey,
		"@project-serve-generation":         spec.Generation,
		"@project-serve-token":              spec.OwnershipToken,
		"@project-serve-workspace-id":       spec.WorkspaceID,
		"@project-serve-runtime-generation": spec.RuntimeGeneration,
		"@project-serve-mode":               string(spec.Mode),
		"@project-serve-apis":               string(spec.APIs),
		"@project-serve-data":               string(spec.Data),
		"@project-serve-local-port":         strconv.Itoa(spec.LocalPort),
		"@project-serve-public-port":        strconv.Itoa(spec.PublicPort),
	}
}

func normalizeTmuxBindings(apis APIsMode, data DataMode) (APIsMode, DataMode) {
	// Sessions created before API/data binding evidence was introduced were
	// always connected to the external APIs and remote data composition.
	if apis == "" && data == "" {
		return APIsModeExternal, DataModeRemote
	}
	return apis, data
}

func sameTmuxOwnership(observed, expected TmuxSessionSpec) bool {
	return observed == expected
}
