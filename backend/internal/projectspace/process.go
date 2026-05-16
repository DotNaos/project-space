package projectspace

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type commandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

func run(name string, args ...string) commandResult {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	command := exec.CommandContext(ctx, name, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	exitCode := 0
	if err != nil {
		exitCode = 1
		if exitError, ok := err.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		}
	}
	return commandResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: exitCode}
}

func shell(cwd string, commandText string) commandResult {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	shellName := "sh"
	shellArgs := []string{"-lc", commandText}
	if runtime.GOOS == "windows" {
		shellName = "cmd"
		shellArgs = []string{"/C", commandText}
	}
	command := exec.CommandContext(ctx, shellName, shellArgs...)
	command.Dir = cwd
	command.Env = os.Environ()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	exitCode := 0
	if err != nil {
		exitCode = 1
		if exitError, ok := err.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		}
	}
	return commandResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: exitCode}
}

func commandExists(name string) (string, bool) {
	path, err := exec.LookPath(name)
	return path, err == nil
}

func lines(text string) []string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}
