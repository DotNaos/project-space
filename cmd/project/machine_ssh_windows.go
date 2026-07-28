//go:build windows

package main

import (
	"os"
	"os/exec"
)

func runInteractiveSSH(target string) error {
	command := exec.Command("ssh", target)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}
