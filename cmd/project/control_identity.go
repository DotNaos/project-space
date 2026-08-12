package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"
)

func newControlGatewayInstallIdentityCommand() *cobra.Command {
	environmentID := ""
	revision := ""
	replace := false
	command := &cobra.Command{
		Use:   "install-identity",
		Short: "Install the root-owned Environment identity binding",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("control gateway identity installation requires root")
			}
			identity := controlGatewayIdentity{
				EnvironmentID:          environmentID,
				TargetIdentityRevision: revision,
			}
			if !validControlGatewayIdentity(identity) {
				return fmt.Errorf("control gateway identity is invalid")
			}
			return writeControlGatewayIdentity(controlGatewayIdentityPath, identity, replace)
		},
	}
	command.Flags().StringVar(&environmentID, "environment-id", "", "exact Environment Instance UUID")
	command.Flags().StringVar(&revision, "target-identity-revision", "", "exact inventory identity revision")
	command.Flags().BoolVar(&replace, "replace", false, "replace a different installed identity")
	_ = command.MarkFlagRequired("environment-id")
	_ = command.MarkFlagRequired("target-identity-revision")
	return command
}

func writeControlGatewayIdentity(
	path string,
	identity controlGatewayIdentity,
	replace bool,
) error {
	encoded, err := json.Marshal(identity)
	if err != nil {
		return fmt.Errorf("encode control gateway identity")
	}
	encoded = append(encoded, '\n')
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0755); err != nil {
		return fmt.Errorf("create control gateway identity directory")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0022 != 0 ||
		!ownedByCurrentUser(info) {
		return fmt.Errorf("control gateway identity directory is not trusted")
	}
	installed, statErr := os.Lstat(path)
	if statErr == nil && (!installed.Mode().IsRegular() || installed.Mode().Perm()&0022 != 0 ||
		!ownedByCurrentUser(installed)) {
		return fmt.Errorf("installed control gateway identity is not trusted")
	}
	if statErr != nil && !os.IsNotExist(statErr) {
		return fmt.Errorf("inspect installed control gateway identity")
	}
	current, readErr := os.ReadFile(path)
	if statErr == nil && readErr == nil {
		if bytes.Equal(current, encoded) {
			return nil
		}
		if !replace {
			return fmt.Errorf("a different control gateway identity is already installed")
		}
	} else if statErr == nil || !os.IsNotExist(readErr) {
		return fmt.Errorf("read installed control gateway identity")
	}
	temporary, err := os.CreateTemp(directory, ".environment-identity-*")
	if err != nil {
		return fmt.Errorf("create control gateway identity")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0644); err != nil {
		temporary.Close()
		return fmt.Errorf("protect control gateway identity")
	}
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return fmt.Errorf("write control gateway identity")
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync control gateway identity")
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close control gateway identity")
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("install control gateway identity")
	}
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open control gateway identity directory")
	}
	defer directoryHandle.Close()
	if err := directoryHandle.Sync(); err != nil {
		return fmt.Errorf("sync control gateway identity directory")
	}
	return nil
}

func ownedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Geteuid()
}

func validControlGatewayIdentity(identity controlGatewayIdentity) bool {
	return controlEnvironmentIDPattern.MatchString(identity.EnvironmentID) &&
		controlRevisionPattern.MatchString(identity.TargetIdentityRevision)
}
