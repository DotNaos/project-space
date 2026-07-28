//go:build windows

package terminallauncher

import (
	"os/exec"
	"syscall"
)

const createNewConsole = 0x00000010

func startDetachedProcess(process Process) error {
	command := exec.Command(process.Name, process.Args...)
	command.Dir = process.Dir
	if process.NewConsole {
		command.SysProcAttr = &syscall.SysProcAttr{
			CreationFlags: createNewConsole,
		}
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
