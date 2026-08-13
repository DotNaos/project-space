//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const (
	projectUpdateNoticeDetachedProcess = 0x00000008
	projectUpdateNoticeNewProcessGroup = 0x00000200
)

func configureProjectUpdateNoticeRefreshProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: projectUpdateNoticeDetachedProcess |
			projectUpdateNoticeNewProcessGroup,
		HideWindow: true,
	}
}
