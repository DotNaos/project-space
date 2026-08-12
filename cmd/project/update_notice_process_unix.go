//go:build darwin || linux

package main

import (
	"os/exec"
	"syscall"
)

func configureProjectUpdateNoticeRefreshProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
