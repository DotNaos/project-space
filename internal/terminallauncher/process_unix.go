//go:build !windows

package terminallauncher

import (
	"errors"
	"os/exec"
)

func startDetachedProcess(process Process) error {
	if process.NewConsole {
		return errors.New("new console is unavailable on this platform")
	}
	command := exec.Command(process.Name, process.Args...)
	command.Dir = process.Dir
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
