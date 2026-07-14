package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	machineConnectorSystemdUnit = "project-space-machine-connector-supervisor.service"
	machineConnectorLaunchLabel = "net.os-home.project-space.machine-connector-supervisor"
)

// ServiceConnectorOptions describes the current Project CLI executable and the
// per-user service domain that should keep `project connector run` alive.
type ServiceConnectorOptions struct {
	Executable string
	GOOS       string
	HomeDir    string
	LinuxUser  string
	UserID     string
	WindowsSID string
	WSLDistro  string
}

// ServiceConnector starts and stops the authenticated connector through the
// host's per-user service manager. It never handles machine credentials.
type ServiceConnector struct {
	executable               string
	goos                     string
	homeDir                  string
	linuxUser                string
	userID                   string
	windowsSID               string
	wslDistro                string
	windowsTaskName          string
	wslTaskName              string
	wslSystemdCleanupTimeout time.Duration
	runner                   serviceCommandRunner
	files                    serviceFileSystem
}

var _ Connector = (*ServiceConnector)(nil)

type serviceCommandRunner interface {
	Run(context.Context, string, ...string) ([]byte, error)
}

type serviceFileSystem interface {
	EnsurePrivateDirectory(string) error
	RemoveFile(string) error
	WritePrivateFile(string, []byte) error
}

func NewServiceConnector(options ServiceConnectorOptions) (*ServiceConnector, error) {
	var err error
	options, err = serviceConnectorOptionsWithDefaults(options, os.Getenv, user.Current)
	if err != nil {
		return nil, err
	}
	return newServiceConnector(options, execServiceCommandRunner{}, osServiceFileSystem{})
}

func serviceConnectorOptionsWithDefaults(
	options ServiceConnectorOptions,
	getenv func(string) string,
	currentUser func() (*user.User, error),
) (ServiceConnectorOptions, error) {
	effectiveGOOS := options.GOOS
	if effectiveGOOS == "" {
		effectiveGOOS = runtime.GOOS
	}
	if effectiveGOOS == "windows" {
		if options.WindowsSID != "" {
			return options, nil
		}
		if currentUser == nil {
			return ServiceConnectorOptions{}, errors.New("resolve current Windows user: user lookup is unavailable")
		}
		resolvedUser, err := currentUser()
		if err != nil {
			return ServiceConnectorOptions{}, fmt.Errorf("resolve current Windows user: %w", err)
		}
		options.WindowsSID = resolvedUser.Uid
		return options, nil
	}
	if effectiveGOOS != "linux" {
		return options, nil
	}
	if options.WSLDistro == "" && getenv != nil {
		options.WSLDistro = getenv("WSL_DISTRO_NAME")
	}
	if options.WSLDistro == "" || options.LinuxUser != "" {
		return options, nil
	}
	if currentUser == nil {
		return ServiceConnectorOptions{}, errors.New("resolve current WSL user: user lookup is unavailable")
	}
	resolvedUser, err := currentUser()
	if err != nil {
		return ServiceConnectorOptions{}, fmt.Errorf("resolve current WSL user: %w", err)
	}
	options.LinuxUser = resolvedUser.Username
	return options, nil
}

func newServiceConnector(
	options ServiceConnectorOptions,
	runner serviceCommandRunner,
	files serviceFileSystem,
) (*ServiceConnector, error) {
	if runner == nil || files == nil {
		return nil, errors.New("machine connector service dependencies are incomplete")
	}
	goos := strings.TrimSpace(options.GOOS)
	if goos == "" {
		goos = runtime.GOOS
	}
	if goos != options.GOOS && options.GOOS != "" || strings.ContainsAny(goos, "\x00\r\n") {
		return nil, errors.New("machine connector operating system is invalid")
	}

	executable := strings.TrimSpace(options.Executable)
	if executable == "" {
		var err error
		executable, err = os.Executable()
		if err != nil {
			return nil, fmt.Errorf("resolve current Project CLI executable: %w", err)
		}
	}
	if strings.ContainsRune(executable, '\x00') {
		return nil, errors.New("machine connector executable is invalid")
	}
	executable, err := filepath.Abs(executable)
	if err != nil {
		return nil, fmt.Errorf("resolve current Project CLI executable: %w", err)
	}

	connector := &ServiceConnector{
		executable: filepath.Clean(executable),
		goos:       goos,
		runner:     runner,
		files:      files,
	}
	if goos == "linux" {
		connector.executable, err = stableLinuxServiceExecutable(connector.executable)
		if err != nil {
			return nil, err
		}
	}
	wslDistro := strings.TrimSpace(options.WSLDistro)
	linuxUser := strings.TrimSpace(options.LinuxUser)
	if wslDistro != "" || linuxUser != "" {
		if goos != "linux" {
			return nil, errors.New("WSL connector service requires linux")
		}
		if options.Executable != "" &&
			(strings.TrimSpace(options.Executable) != options.Executable ||
				strings.ContainsAny(options.Executable, "\x00\r\n")) {
			return nil, errors.New("WSL connector executable is invalid")
		}
		if wslDistro != options.WSLDistro || !validWSLDistro(wslDistro) {
			return nil, errors.New("WSL distribution name is invalid")
		}
		if linuxUser != options.LinuxUser || !validLinuxUser(linuxUser) {
			return nil, errors.New("WSL Linux user is invalid")
		}
		connector.wslDistro = wslDistro
		connector.linuxUser = linuxUser
		connector.wslTaskName = wslScheduledTaskName(wslDistro, linuxUser)
		connector.wslSystemdCleanupTimeout = defaultWSLSystemdCleanupTimeout
	}
	if goos == "windows" {
		windowsSID := strings.TrimSpace(options.WindowsSID)
		if windowsSID != options.WindowsSID || !validWindowsSID(windowsSID) {
			return nil, errors.New("Windows connector user SID is invalid")
		}
		connector.windowsSID = windowsSID
		connector.windowsTaskName = nativeWindowsScheduledTaskName(windowsSID)
	}
	if goos != "darwin" {
		return connector, nil
	}

	homeDir := strings.TrimSpace(options.HomeDir)
	if homeDir == "" {
		homeDir, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve user home for connector LaunchAgent: %w", err)
		}
	}
	if strings.ContainsRune(homeDir, '\x00') || !filepath.IsAbs(homeDir) {
		return nil, errors.New("connector LaunchAgent home directory is invalid")
	}
	connector.homeDir = filepath.Clean(homeDir)

	userID := strings.TrimSpace(options.UserID)
	if userID == "" {
		currentUser, currentErr := user.Current()
		if currentErr != nil {
			return nil, fmt.Errorf("resolve user ID for connector LaunchAgent: %w", currentErr)
		}
		userID = currentUser.Uid
	}
	if !decimalUserID(userID) {
		return nil, errors.New("connector LaunchAgent user ID is invalid")
	}
	connector.userID = userID
	return connector, nil
}

func stableLinuxServiceExecutable(executable string) (string, error) {
	if _, managed := possibleConnectorSupervisorToolsRoot(executable); !managed {
		return executable, nil
	}
	toolsRoot, err := ResolveConnectorSupervisorMaintenanceToolsRoot(executable)
	if err != nil {
		return "", fmt.Errorf("resolve managed Linux connector service executable: %w", err)
	}
	stable := filepath.Join(toolsRoot, connectorSupervisorCurrentPointerName, filepath.Base(executable))
	info, err := os.Stat(stable)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 ||
		info.Mode().Perm()&0o022 != 0 {
		return "", errors.New("managed Linux connector service executable is unsafe")
	}
	return stable, nil
}

func (connector *ServiceConnector) Start(ctx context.Context) error {
	if ctx == nil {
		return errors.New("machine connector service context is missing")
	}
	switch connector.goos {
	case "linux":
		if connector.wslDistro != "" {
			return connector.startWSLScheduledTask(ctx)
		}
		return connector.startSystemd(ctx)
	case "darwin":
		return connector.startLaunchd(ctx)
	case "windows":
		return connector.startWindowsScheduledTask(ctx)
	default:
		return fmt.Errorf("machine connector service control is not supported on %s", connector.goos)
	}
}

func (connector *ServiceConnector) Stop(ctx context.Context) error {
	if ctx == nil {
		return errors.New("machine connector service context is missing")
	}
	switch connector.goos {
	case "linux":
		if connector.wslDistro != "" {
			return connector.stopWSLScheduledTask(ctx)
		}
		return connector.stopSystemd(ctx)
	case "darwin":
		return connector.stopLaunchd(ctx)
	case "windows":
		return connector.stopWindowsScheduledTask(ctx)
	default:
		return fmt.Errorf("machine connector service control is not supported on %s", connector.goos)
	}
}

func decimalUserID(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

type execServiceCommandRunner struct{}

func (execServiceCommandRunner) Run(
	ctx context.Context,
	name string,
	arguments ...string,
) ([]byte, error) {
	command := exec.CommandContext(ctx, name, arguments...)
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		return output, ctx.Err()
	}
	if err != nil {
		return output, fmt.Errorf("run %s: %w", name, err)
	}
	return output, nil
}

func commandUnavailable(err error) bool {
	var execError *exec.Error
	return errors.As(err, &execError)
}
