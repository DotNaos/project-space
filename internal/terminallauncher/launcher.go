package terminallauncher

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

var (
	ErrHeadless         = errors.New("no graphical desktop is available")
	ErrInvalidDirectory = errors.New("terminal directory is not an existing directory")
	ErrNoLauncher       = errors.New("no usable terminal launcher is installed")
	ErrUnsupported      = errors.New("opening a terminal is unsupported on this platform")
)

type Selection string

const (
	SelectionSystemDefault Selection = "system-default"
	SelectionFallback      Selection = "fallback"
)

type Result struct {
	Launcher  string    `json:"launcher"`
	Selection Selection `json:"selection"`
}

type Application struct {
	BundleID string
	Name     string
}

type Process struct {
	Args       []string
	Dir        string
	Name       string
	NewConsole bool
}

type Dependencies struct {
	Getenv               func(string) string
	LookPath             func(string) (string, error)
	ResolveDarwinDefault func(context.Context) (Application, error)
	Start                func(Process) error
	Stat                 func(string) (os.FileInfo, error)
}

type Launcher interface {
	Open(context.Context, string) (Result, error)
}

type platformLauncher struct {
	dependencies Dependencies
	platform     string
}

func New() Launcher {
	return newPlatformLauncher(runtime.GOOS, Dependencies{})
}

func newPlatformLauncher(platform string, dependencies Dependencies) Launcher {
	if dependencies.Getenv == nil {
		dependencies.Getenv = os.Getenv
	}
	if dependencies.LookPath == nil {
		dependencies.LookPath = exec.LookPath
	}
	if dependencies.ResolveDarwinDefault == nil {
		dependencies.ResolveDarwinDefault = resolveDarwinDefaultTerminal
	}
	if dependencies.Start == nil {
		dependencies.Start = startDetachedProcess
	}
	if dependencies.Stat == nil {
		dependencies.Stat = os.Stat
	}
	return &platformLauncher{dependencies: dependencies, platform: platform}
}

func (launcher *platformLauncher) Open(
	ctx context.Context,
	directory string,
) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if !filepath.IsAbs(directory) {
		return Result{}, ErrInvalidDirectory
	}
	info, err := launcher.dependencies.Stat(directory)
	if err != nil || !info.IsDir() {
		return Result{}, ErrInvalidDirectory
	}
	switch launcher.platform {
	case "darwin":
		return launcher.openDarwin(ctx, directory)
	case "windows":
		return launcher.openWindows(directory)
	case "linux":
		return launcher.openLinux(directory)
	default:
		return Result{}, fmt.Errorf("%w: %s", ErrUnsupported, launcher.platform)
	}
}

func (launcher *platformLauncher) openDarwin(
	ctx context.Context,
	directory string,
) (Result, error) {
	application, err := launcher.dependencies.ResolveDarwinDefault(ctx)
	if err != nil || application.BundleID == "" || application.Name == "" {
		return Result{}, fmt.Errorf("%w: macOS default terminal could not be resolved", ErrNoLauncher)
	}
	open, err := launcher.dependencies.LookPath("open")
	if err != nil {
		return Result{}, fmt.Errorf("%w: macOS open utility is unavailable", ErrNoLauncher)
	}
	if err := launcher.dependencies.Start(Process{
		Args: []string{"-b", application.BundleID, "--", directory},
		Name: open,
	}); err != nil {
		return Result{}, fmt.Errorf("launch %s: %w", application.Name, err)
	}
	return Result{Launcher: application.Name, Selection: SelectionSystemDefault}, nil
}

func (launcher *platformLauncher) openWindows(directory string) (Result, error) {
	command, err := launcher.dependencies.LookPath("cmd.exe")
	if err != nil {
		return Result{}, fmt.Errorf("%w: cmd.exe is unavailable", ErrNoLauncher)
	}
	if err := launcher.dependencies.Start(Process{
		Args:       []string{"/d", "/k"},
		Dir:        directory,
		Name:       command,
		NewConsole: true,
	}); err != nil {
		return Result{}, fmt.Errorf("launch Windows default console host: %w", err)
	}
	return Result{
		Launcher:  "Windows default console host",
		Selection: SelectionSystemDefault,
	}, nil
}

func (launcher *platformLauncher) openLinux(directory string) (Result, error) {
	if launcher.dependencies.Getenv("DISPLAY") == "" &&
		launcher.dependencies.Getenv("WAYLAND_DISPLAY") == "" {
		return Result{}, ErrHeadless
	}
	for _, candidate := range []struct {
		name      string
		selection Selection
	}{
		{name: "xdg-terminal-exec", selection: SelectionSystemDefault},
		{name: "x-terminal-emulator", selection: SelectionFallback},
	} {
		command, err := launcher.dependencies.LookPath(candidate.name)
		if err != nil {
			continue
		}
		if err := launcher.dependencies.Start(Process{
			Dir:  directory,
			Name: command,
		}); err != nil {
			return Result{}, fmt.Errorf("launch %s: %w", candidate.name, err)
		}
		return Result{Launcher: candidate.name, Selection: candidate.selection}, nil
	}
	return Result{}, fmt.Errorf(
		"%w: install xdg-terminal-exec or configure x-terminal-emulator",
		ErrNoLauncher,
	)
}
