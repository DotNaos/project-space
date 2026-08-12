package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/DotNaos/project-space/internal/workspacerun"
	"github.com/DotNaos/project-space/internal/workspacesession"
	"github.com/spf13/cobra"
)

func newWorkspaceRuntimeSessionCommand() *cobra.Command {
	bootstrapPath := ""
	command := &cobra.Command{
		Use: "__workspace-runtime-session", Hidden: true, Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			info, err := os.Lstat(bootstrapPath)
			if err != nil || !filepath.IsAbs(bootstrapPath) || filepath.Clean(bootstrapPath) != bootstrapPath ||
				!info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 16*1024 {
				return fmt.Errorf("Workspace Runtime bootstrap is not protected")
			}
			file, err := os.Open(bootstrapPath)
			if err != nil {
				return fmt.Errorf("read Workspace Runtime bootstrap")
			}
			defer file.Close()
			opened, err := file.Stat()
			if err != nil || !os.SameFile(info, opened) {
				return fmt.Errorf("Workspace Runtime bootstrap changed while opening")
			}
			var bootstrap workspacesession.Bootstrap
			decoder := json.NewDecoder(io.LimitReader(file, 16*1024+1))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&bootstrap); err != nil {
				return fmt.Errorf("decode Workspace Runtime bootstrap")
			}
			var extra any
			if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
				return fmt.Errorf("decode Workspace Runtime bootstrap")
			}
			if err := workspacesession.ValidateBootstrap(bootstrap, time.Now()); err != nil || bootstrap.ReadyPath == "" {
				return fmt.Errorf("Workspace Runtime launch bootstrap is invalid")
			}
			return runWorkspaceRuntimeSession(command.Context(), command, bootstrap)
		},
	}
	command.Flags().StringVar(&bootstrapPath, "bootstrap", "", "protected Runtime Session bootstrap path")
	_ = command.MarkFlagRequired("bootstrap")
	return command
}

func runWorkspaceRuntimeSession(
	ctx context.Context,
	command *cobra.Command,
	bootstrap workspacesession.Bootstrap,
) error {
	client := workspacesession.Client{}
	if containsRuntimeCapability(bootstrap.RequestedCapabilities, "runtime.mutation.v1") {
		manager, err := workspacerun.NewDefaultManager()
		if err != nil {
			return fmt.Errorf("Workspace Runtime mutation manager is unavailable")
		}
		client.Mutations = workspacerun.SessionMutationAdapter{Manager: manager}
	}
	return runWorkspaceRuntimeSessionWithClient(ctx, command, bootstrap, client.Run)
}

func runWorkspaceRuntimeSessionWithClient(
	ctx context.Context,
	_ *cobra.Command,
	bootstrap workspacesession.Bootstrap,
	runSession func(context.Context, workspacesession.Bootstrap) error,
) error {
	return runSession(ctx, bootstrap)
}
