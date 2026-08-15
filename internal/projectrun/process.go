package projectrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/DotNaos/project-space/internal/infisicalref"
	"golang.org/x/sys/unix"
)

type OSProcessRunner struct {
	SupervisorExecutable string
}

func (OSProcessRunner) RunForeground(
	ctx context.Context,
	command Command,
	streams Streams,
	commit ProcessCommit,
) (int, error) {
	cmd, err := prepareCommand(ctx, command)
	if err != nil {
		return -1, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = streams.Stdin, streams.Stdout, streams.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("start %q: %w", command.Argv[0], err)
	}
	process := ProcessRef{PID: cmd.Process.Pid}
	process.Identity, err = readProcessIdentity(process.PID)
	if err != nil {
		_ = syscall.Kill(-process.PID, syscall.SIGKILL)
		_ = cmd.Wait()
		return -1, fmt.Errorf("capture foreground process identity: %w", err)
	}
	if commit != nil {
		if err := commit(process); err != nil {
			_ = syscall.Kill(-process.PID, syscall.SIGKILL)
			_ = cmd.Wait()
			return -1, fmt.Errorf("commit foreground process identity: %w", err)
		}
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	select {
	case err := <-waited:
		if ctx.Err() != nil {
			return commandExitCode(err), ctx.Err()
		}
		return commandExitCode(err), commandWaitError(command.Argv[0], err)
	case <-ctx.Done():
		stopErr := stopProcessGroup(process, 3*time.Second)
		if stopErr == nil {
			<-waited
		} else {
			select {
			case <-waited:
			case <-time.After(time.Second):
			}
		}
		return -1, errors.Join(ctx.Err(), stopErr)
	}
}

func (runner OSProcessRunner) StartDetached(
	command Command,
	outputPath string,
	commit ProcessCommit,
) (ProcessRef, error) {
	if commit == nil {
		return ProcessRef{}, fmt.Errorf("detached process commit callback must not be nil")
	}
	executable := runner.SupervisorExecutable
	if executable == "" {
		var err error
		executable, err = os.Executable()
		if err != nil {
			return ProcessRef{}, fmt.Errorf("resolve Project CLI executable: %w", err)
		}
	}
	return startSupervisedDetached(executable, command, outputPath, nil, commit)
}

// StartDetachedWithOutput starts a supervised process whose log is already
// opened beneath an ownership-checked directory. The supervisor inherits a
// duplicate descriptor and never resolves the log path again.
func (runner OSProcessRunner) StartDetachedWithOutput(
	command Command,
	output *os.File,
	commit ProcessCommit,
) (ProcessRef, error) {
	if output == nil {
		return ProcessRef{}, fmt.Errorf("managed runtime output file is required")
	}
	executable := runner.SupervisorExecutable
	if executable == "" {
		var err error
		executable, err = os.Executable()
		if err != nil {
			return ProcessRef{}, fmt.Errorf("resolve Project CLI executable: %w", err)
		}
	}
	return startSupervisedDetached(executable, command, "", output, commit)
}

func startSupervisedDetached(
	supervisorExecutable string,
	command Command,
	outputPath string,
	outputFile *os.File,
	commit ProcessCommit,
) (ProcessRef, error) {
	if _, err := validateProcessCommand(command); err != nil {
		return ProcessRef{}, err
	}
	controlReader, controlWriter, err := os.Pipe()
	if err != nil {
		return ProcessRef{}, fmt.Errorf("create runtime supervisor control pipe: %w", err)
	}
	defer controlReader.Close()
	defer controlWriter.Close()
	ackReader, ackWriter, err := os.Pipe()
	if err != nil {
		return ProcessRef{}, fmt.Errorf("create runtime supervisor acknowledgement pipe: %w", err)
	}
	defer ackReader.Close()
	defer ackWriter.Close()

	discard, err := managedOutput("")
	if err != nil {
		return ProcessRef{}, err
	}
	defer discard.Close()
	arguments := []string{RuntimeSupervisorCommandName, outputPath}
	if outputFile != nil {
		arguments = []string{RuntimeSupervisorCommandName, "--inherited-log"}
	}
	supervisorCommand := exec.Command(supervisorExecutable, arguments...)
	if outputFile != nil {
		supervisorCommand.ExtraFiles = []*os.File{outputFile}
	}
	supervisorCommand.Stdin = controlReader
	supervisorCommand.Stdout, supervisorCommand.Stderr = ackWriter, discard
	supervisorCommand.Env = safeEnvironment(os.Environ())
	supervisorCommand.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := supervisorCommand.Start(); err != nil {
		return ProcessRef{}, fmt.Errorf("start managed runtime supervisor: %w", err)
	}
	supervisor := ProcessRef{PID: supervisorCommand.Process.Pid}
	supervisor.Identity, err = readProcessIdentity(supervisor.PID)
	if err != nil {
		_ = syscall.Kill(-supervisor.PID, syscall.SIGKILL)
		_ = supervisorCommand.Wait()
		return ProcessRef{}, fmt.Errorf("capture runtime supervisor identity: %w", err)
	}
	_ = controlReader.Close()
	_ = ackWriter.Close()

	stopSupervisor := func() {
		_ = controlWriter.Close()
		_ = ackReader.Close()
		_ = stopProcessGroup(supervisor, time.Second)
		_ = supervisorCommand.Wait()
	}
	if err := commit(supervisor); err != nil {
		stopSupervisor()
		return ProcessRef{}, fmt.Errorf("commit runtime supervisor identity: %w", err)
	}
	if err := writeRuntimeSupervisorRequest(controlWriter, command); err != nil {
		stopSupervisor()
		return ProcessRef{}, err
	}
	_ = controlWriter.Close()
	if err := ackReader.SetReadDeadline(time.Now().Add(runtimeSupervisorHandshakeTimeout)); err != nil {
		stopSupervisor()
		return ProcessRef{}, fmt.Errorf("set runtime supervisor handshake deadline: %w", err)
	}
	ack, err := readRuntimeSupervisorAck(ackReader)
	if err != nil {
		stopSupervisor()
		return ProcessRef{}, err
	}
	if !ack.Started {
		stopSupervisor()
		if ack.Error == "" {
			ack.Error = "runtime supervisor did not start the managed command"
		}
		return ProcessRef{}, errors.New(ack.Error)
	}
	go func() { _ = supervisorCommand.Wait() }()
	return supervisor, nil
}

func (OSProcessRunner) Alive(process ProcessRef) bool {
	if process.PID <= 0 || process.Identity == "" || !pidExists(process.PID) {
		return false
	}
	identity, err := readProcessIdentity(process.PID)
	return err == nil && identity == process.Identity
}

func (OSProcessRunner) PIDExists(pid int) bool { return pid > 0 && pidExists(pid) }

// Suspended reports whether the exact managed process is currently stopped.
func (runner OSProcessRunner) Suspended(process ProcessRef) (bool, error) {
	if !runner.Alive(process) {
		return false, fmt.Errorf("process identity no longer matches PID %d", process.PID)
	}
	command := exec.Command("ps", "-o", "state=", "-p", strconv.Itoa(process.PID))
	command.Env = safeEnvironment(os.Environ())
	body, err := command.Output()
	if err != nil {
		return false, fmt.Errorf("inspect process %d state: %w", process.PID, err)
	}
	state := strings.TrimSpace(string(body))
	if state == "" {
		return false, fmt.Errorf("process %d state is unavailable", process.PID)
	}
	if !runner.Alive(process) {
		return false, fmt.Errorf("process identity changed while inspecting PID %d", process.PID)
	}
	return state[0] == 'T', nil
}

func (OSProcessRunner) OwnsTCP(process ProcessRef, host string, port int) (bool, error) {
	if !(OSProcessRunner{}).Alive(process) {
		return false, fmt.Errorf("process identity no longer matches PID %d", process.PID)
	}
	listeners, err := tcpListeners(port)
	if err != nil {
		return false, err
	}
	expected := net.JoinHostPort(host, strconv.Itoa(port))
	return ownsExclusiveTCP(process.PID, expected, listeners, syscall.Getpgid)
}

// OwnsUnixSocket proves that exactly one process in the recorded process group
// has the named Unix socket open.
func (runner OSProcessRunner) OwnsUnixSocket(process ProcessRef, path string) (bool, error) {
	if !runner.Alive(process) || path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return false, nil
	}
	executable, err := lsofExecutable()
	if err != nil {
		return false, fmt.Errorf("lsof is required to verify the Codex app-server socket owner: %w", err)
	}
	command := exec.Command(executable, "-n", "-Fpn", "--", path)
	command.Env = safeEnvironment(os.Environ())
	body, err := command.Output()
	if exitError := (&exec.ExitError{}); errors.As(err, &exitError) && exitError.ExitCode() == 1 {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect Unix socket owner: %w", err)
	}
	owners := map[int]bool{}
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "p") {
			continue
		}
		pid, parseErr := strconv.Atoi(strings.TrimPrefix(line, "p"))
		if parseErr != nil || pid <= 0 {
			return false, fmt.Errorf("inspect Unix socket owner: invalid PID evidence")
		}
		group, groupErr := syscall.Getpgid(pid)
		if groupErr != nil || group != process.PID {
			return false, nil
		}
		owners[pid] = true
	}
	return len(owners) == 1 && runner.Alive(process), nil
}

func ownsExclusiveTCP(
	processGroup int,
	expected string,
	listeners []tcpListener,
	processGroupForPID func(int) (int, error),
) (bool, error) {
	found := false
	for _, listener := range listeners {
		group, err := processGroupForPID(listener.PID)
		if err != nil {
			return false, fmt.Errorf("inspect process group for listener PID %d: %w", listener.PID, err)
		}
		if group != processGroup || listener.Address != expected {
			return false, nil
		}
		found = true
	}
	return found, nil
}

func (OSProcessRunner) TCPPortOpen(port int) (bool, error) {
	listeners, err := tcpListeners(port)
	return len(listeners) > 0, err
}

type tcpListener struct {
	PID     int
	Address string
}

func tcpListeners(port int) ([]tcpListener, error) {
	executable, err := lsofExecutable()
	if err != nil {
		return nil, fmt.Errorf("lsof is required to verify the dev-server port owner: %w", err)
	}
	cmd := exec.Command(executable, "-nP", "-a", "-Fpn", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN")
	cmd.Env = safeEnvironment(os.Environ())
	body, err := cmd.Output()
	if exitError := (&exec.ExitError{}); errors.As(err, &exitError) && exitError.ExitCode() == 1 {
		return []tcpListener{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect listener on port %d: %w", port, err)
	}
	listeners := []tcpListener{}
	currentPID := 0
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, "p") {
			currentPID, _ = strconv.Atoi(strings.TrimPrefix(line, "p"))
			continue
		}
		if strings.HasPrefix(line, "n") && currentPID > 0 {
			listeners = append(listeners, tcpListener{
				PID: currentPID, Address: strings.TrimPrefix(line, "n"),
			})
		}
	}
	return listeners, nil
}

func lsofExecutable() (string, error) {
	if executable, err := exec.LookPath("lsof"); err == nil {
		return executable, nil
	}
	for _, candidate := range []string{"/usr/sbin/lsof", "/usr/bin/lsof"} {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("lsof is not installed")
}

func (OSProcessRunner) StopGroup(process ProcessRef, timeout time.Duration) error {
	return stopProcessGroup(process, timeout)
}

// SuspendGroup pauses an exact managed process group only while the recorded
// process identity still names its live group leader.
func (runner OSProcessRunner) SuspendGroup(process ProcessRef) error {
	if err := runner.verifyGroupLeader(process); err != nil {
		return fmt.Errorf("refusing to suspend process group %d: %w", process.PID, err)
	}
	if err := syscall.Kill(-process.PID, syscall.SIGSTOP); err != nil {
		return fmt.Errorf("suspend process group %d: %w", process.PID, err)
	}
	return nil
}

// ResumeGroup continues an exact managed process group only while the recorded
// process identity still names its live group leader.
func (runner OSProcessRunner) ResumeGroup(process ProcessRef) error {
	if err := runner.verifyGroupLeader(process); err != nil {
		return fmt.Errorf("refusing to resume process group %d: %w", process.PID, err)
	}
	if err := syscall.Kill(-process.PID, syscall.SIGCONT); err != nil {
		return fmt.Errorf("resume process group %d: %w", process.PID, err)
	}
	return nil
}

func (runner OSProcessRunner) verifyGroupLeader(process ProcessRef) error {
	if !runner.Alive(process) {
		return fmt.Errorf("verified leader is gone")
	}
	group, err := syscall.Getpgid(process.PID)
	if err != nil {
		return fmt.Errorf("inspect process group: %w", err)
	}
	if group != process.PID {
		return fmt.Errorf("PID is no longer its process-group leader")
	}
	if !runner.Alive(process) {
		return fmt.Errorf("verified leader changed while checking its process group")
	}
	return nil
}

func validateProcessCommand(command Command) (string, error) {
	if len(command.Argv) == 0 {
		return "", fmt.Errorf("command must not be empty")
	}
	executable, err := exec.LookPath(command.Argv[0])
	if err != nil {
		return "", fmt.Errorf("find %q: %w", command.Argv[0], err)
	}
	plainEnvironment := environmentMap(command.Env)
	for name, source := range command.SecretEnvironment {
		if _, err := infisicalref.Parse(source, name); err != nil {
			return "", fmt.Errorf("secret environment %s is invalid: %w", name, err)
		}
		if _, exists := plainEnvironment[name]; exists {
			return "", fmt.Errorf("secret environment %s conflicts with the plain command environment", name)
		}
	}
	return executable, nil
}

func prepareCommand(ctx context.Context, command Command) (*exec.Cmd, error) {
	executable, err := validateProcessCommand(command)
	if err != nil {
		return nil, err
	}
	secrets, err := resolveCommandSecrets(ctx, command.SecretEnvironment)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(executable, command.Argv[1:]...)
	cmd.Dir = command.Dir
	base := safeEnvironment(os.Environ())
	if command.InheritEnv {
		base = os.Environ()
	}
	cmd.Env = mergeEnvironment(base, environmentMap(command.Env))
	cmd.Env = mergeEnvironment(cmd.Env, secrets)
	return cmd, nil
}

func resolveCommandSecrets(ctx context.Context, sources map[string]string) (map[string]string, error) {
	resolved := make(map[string]string, len(sources))
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		reference, err := infisicalref.Parse(sources[name], name)
		if err != nil {
			return nil, fmt.Errorf("secret environment %s is invalid: %w", name, err)
		}
		fetch := exec.CommandContext(
			ctx,
			"infisical", "secrets", "get", reference.SecretName,
			"--plain", "--silent", "--domain=https://eu.infisical.com",
			"--projectId="+reference.ProjectID, "--env="+reference.Environment,
			"--path=/", "--include-imports=false", "--recursive=false",
		)
		fetch.Env = mergeEnvironment(safeEnvironment(os.Environ()), map[string]string{
			"INFISICAL_DISABLE_UPDATE_CHECK": "true",
		})
		fetch.Stderr = io.Discard
		output, err := fetch.Output()
		if err != nil {
			return nil, fmt.Errorf("read declared secret %s from Infisical: %w", name, err)
		}
		value := strings.TrimRight(string(output), "\r\n")
		if value == "" {
			return nil, fmt.Errorf("declared secret %s from Infisical is empty", name)
		}
		if strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("declared secret %s contains a null byte", name)
		}
		resolved[name] = value
	}
	return resolved, nil
}

func managedOutput(path string) (*os.File, error) {
	if path == "" {
		return os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	}
	parent := filepath.Dir(path)
	directoryFD, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open managed output directory: %w", err)
	}
	defer unix.Close(directoryFD)
	fd, err := unix.Openat(directoryFD, filepath.Base(path), unix.O_CREAT|unix.O_TRUNC|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open managed output: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		_ = file.Close()
		return nil, fmt.Errorf("open managed output: target is not a private regular file")
	}
	return file, nil
}

func safeEnvironment(environment []string) []string {
	allowed := map[string]bool{
		"ANDROID_HOME": true, "ANDROID_SDK_ROOT": true, "ASDF_DATA_DIR": true,
		"BUN_INSTALL": true, "CARGO_HOME": true, "COREPACK_HOME": true,
		"DEVELOPER_DIR": true, "GOCACHE": true, "GOMODCACHE": true,
		"GOPATH": true, "GOROOT": true, "HOME": true, "JAVA_HOME": true,
		"LANG": true, "LC_ALL": true, "LOGNAME": true, "MISE_DATA_DIR": true,
		"NVM_DIR": true, "PATH": true, "PNPM_HOME": true, "PYENV_ROOT": true,
		"PORTLESS_HTTPS": true, "PORTLESS_PORT": true, "PORTLESS_STATE_DIR": true,
		"PORTLESS_SYNC_HOSTS": true, "PORTLESS_TLD": true,
		"RUSTUP_HOME": true, "SDKROOT": true, "SHELL": true, "SSL_CERT_DIR": true,
		"SSL_CERT_FILE": true, "TEMP": true, "TMP": true, "TMPDIR": true,
		"TZ": true, "USER": true, "UV_CACHE_DIR": true, "VIRTUAL_ENV": true,
		"VOLTA_HOME": true, "XDG_CACHE_HOME": true, "XDG_CONFIG_HOME": true,
		"XDG_DATA_HOME": true, "XDG_STATE_HOME": true,
	}
	result := make([]string, 0, len(allowed))
	for _, entry := range environment {
		key, _, ok := cutEnvironment(entry)
		if ok && (allowed[key] || strings.HasPrefix(key, "LC_")) {
			result = append(result, entry)
		}
	}
	return result
}

func environmentMap(entries []string) map[string]string {
	values := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := cutEnvironment(entry)
		if ok {
			values[key] = value
		}
	}
	return values
}

func cutEnvironment(entry string) (string, string, bool) {
	key, value, ok := strings.Cut(entry, "=")
	return key, value, ok && key != ""
}

func readProcessIdentity(pid int) (string, error) {
	if runtime.GOOS == "linux" {
		return readLinuxProcessIdentity(pid)
	}
	executable, err := exec.LookPath("ps")
	if err != nil {
		return "", err
	}
	cmd := exec.Command(executable, "-ww", "-p", strconv.Itoa(pid), "-o", "lstart=", "-o", "comm=")
	cmd.Env = safeEnvironment(os.Environ())
	body, err := cmd.Output()
	if err != nil {
		return "", err
	}
	identity := strings.TrimSpace(string(body))
	if identity == "" {
		return "", fmt.Errorf("process %d disappeared", pid)
	}
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:]), nil
}

func readLinuxProcessIdentity(pid int) (string, error) {
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	body, err := os.ReadFile(statPath)
	if err != nil {
		return "", fmt.Errorf("read Linux process start time: %w", err)
	}
	startTime, err := parseLinuxProcessStartTime(string(body))
	if err != nil {
		return "", fmt.Errorf("parse Linux process start time for PID %d: %w", pid, err)
	}
	executable, err := os.Stat(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return "", fmt.Errorf("inspect Linux process executable: %w", err)
	}
	metadata, ok := executable.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("inspect Linux process executable identity")
	}
	identity := fmt.Sprintf("linux\x00%d\x00%s\x00%d\x00%d", pid, startTime, metadata.Dev, metadata.Ino)
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:]), nil
}

func parseLinuxProcessStartTime(body string) (string, error) {
	closing := strings.LastIndex(body, ") ")
	if closing < 0 {
		return "", fmt.Errorf("missing process name terminator")
	}
	fields := strings.Fields(body[closing+2:])
	if len(fields) <= 19 || fields[19] == "" {
		return "", fmt.Errorf("missing start-time field")
	}
	return fields[19], nil
}

func stopProcessGroup(process ProcessRef, timeout time.Duration) error {
	if process.PID <= 0 {
		return nil
	}
	if !pidExists(process.PID) {
		if processGroupExists(process.PID) {
			return fmt.Errorf("refusing to stop process group %d because its verified leader is gone", process.PID)
		}
		return nil
	}
	identity, err := readProcessIdentity(process.PID)
	if err != nil {
		return fmt.Errorf("verify process %d before stopping: %w", process.PID, err)
	}
	if process.Identity == "" || identity != process.Identity {
		return fmt.Errorf("refusing to stop PID %d because its identity changed", process.PID)
	}
	group, err := syscall.Getpgid(process.PID)
	if err != nil {
		return fmt.Errorf("read process group for PID %d: %w", process.PID, err)
	}
	if group != process.PID {
		return fmt.Errorf("refusing to stop PID %d because it is no longer its process-group leader", process.PID)
	}
	if err := syscall.Kill(-process.PID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("stop process group %d: %w", process.PID, err)
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processGroupExists(process.PID) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := syscall.Kill(-process.PID, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("kill process group %d: %w", process.PID, err)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if !processGroupExists(process.PID) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("process group %d still has descendants after SIGKILL", process.PID)
}

func pidExists(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func processGroupExists(group int) bool {
	err := syscall.Kill(-group, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func commandExitCode(err error) int {
	if err == nil {
		return 0
	}
	exitError := &exec.ExitError{}
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}

func commandWaitError(name string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s exited with code %d: %w", name, commandExitCode(err), err)
}
