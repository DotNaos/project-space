//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func runInteractiveSSH(target string) error {
	binary, err := exec.LookPath("ssh")
	if err != nil {
		return err
	}
	return syscall.Exec(binary, []string{"ssh", target}, os.Environ())
}
