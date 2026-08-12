//go:build !darwin && !linux && !windows

package main

import "os/exec"

func configureProjectUpdateNoticeRefreshProcess(_ *exec.Cmd) {}
