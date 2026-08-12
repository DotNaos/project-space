package workspacerun

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

const maximumDevcontainerBytes = 256 << 10

var digestImagePattern = regexp.MustCompile(`^[^\s@]+@sha256:[a-f0-9]{64}$`)

type safeDevcontainer struct {
	Image           string   `json:"image"`
	RemoteUser      string   `json:"remoteUser"`
	WorkspaceFolder string   `json:"workspaceFolder"`
	RunArgs         []string `json:"runArgs,omitempty"`
}

func validateDevcontainer(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maximumDevcontainerBytes+1))
	decoder.DisallowUnknownFields()
	declaration := safeDevcontainer{}
	if err := decoder.Decode(&declaration); err != nil {
		return fmt.Errorf("parse strict devcontainer declaration: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = fmt.Errorf("multiple JSON values are not supported")
		}
		return fmt.Errorf("parse strict devcontainer declaration: %w", err)
	}
	if !digestImagePattern.MatchString(declaration.Image) {
		return fmt.Errorf("image must be pinned by SHA-256 digest")
	}
	if strings.TrimSpace(declaration.RemoteUser) != declaration.RemoteUser || declaration.RemoteUser == "" || declaration.RemoteUser == "root" || strings.ContainsAny(declaration.RemoteUser, "\x00\r\n\t /") {
		return fmt.Errorf("remoteUser must be a non-root account name")
	}
	if declaration.WorkspaceFolder != "/workspace" {
		return fmt.Errorf("workspaceFolder must be /workspace")
	}
	if len(declaration.RunArgs) > 16 {
		return fmt.Errorf("runArgs must contain at most 16 entries")
	}
	for _, argument := range declaration.RunArgs {
		if argument != "--init" && argument != "--read-only" {
			return fmt.Errorf("runArg %q is not allowed", argument)
		}
	}
	return nil
}
