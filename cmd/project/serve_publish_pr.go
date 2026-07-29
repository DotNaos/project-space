//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

const pullRequestDevServerPath = "/api/pull-request-previews/dev-server/"

type pullRequestPublishOptions struct {
	BranchName        string
	CommitSHA         string
	CodexThreadID     string
	MachineID         string
	ProjectID         string
	PullRequestNumber int
	Repository        string
	Script            string
	ServedSurface     string
	WorktreeID        string
}

type pullRequestDevServerLease struct {
	HeartbeatIntervalSeconds int `json:"heartbeatIntervalSeconds"`
	Lease                    struct {
		ExpiresAt  string `json:"expiresAt"`
		Generation int    `json:"generation"`
		ID         string `json:"id"`
	} `json:"lease"`
}

type pullRequestPublishDependencies struct {
	Client  *http.Client
	Load    func() (machineconnect.Credential, error)
	Now     func() time.Time
	Sleep   func(context.Context, time.Duration) error
	GitInfo func(string) (branch string, commit string, err error)
}

func newServePublishPullRequestCommand(managerFactory projectManagerFactory) *cobra.Command {
	return newServePublishPullRequestCommandWithDependencies(
		managerFactory,
		defaultPullRequestPublishDependencies,
	)
}

func newServePublishPullRequestCommandWithDependencies(
	managerFactory projectManagerFactory,
	loadDependencies func() (pullRequestPublishDependencies, error),
) *cobra.Command {
	options := pullRequestPublishOptions{
		CodexThreadID: strings.TrimSpace(os.Getenv("CODEX_THREAD_ID")),
		Script:        "prototype-desktop",
	}
	command := &cobra.Command{
		Use:               "publish-pr [directory]",
		Short:             "Publish a managed dev server to one pull request",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(command *cobra.Command, args []string) error {
			if err := validatePullRequestPublishOptions(options); err != nil {
				return err
			}
			directory := argumentOrCurrentDirectory(args)
			dependencies, err := loadDependencies()
			if err != nil {
				return err
			}
			branch, commit, err := dependencies.GitInfo(directory)
			if err != nil {
				return err
			}
			if options.BranchName != "" && options.BranchName != branch {
				return fmt.Errorf("checked-out branch is %q, not %q", branch, options.BranchName)
			}
			if options.CommitSHA != "" && !strings.EqualFold(options.CommitSHA, commit) {
				return errors.New("checked-out commit does not match --commit")
			}
			options.BranchName, options.CommitSHA = branch, commit
			_, script, err := projectrun.LoadScript(directory, options.Script)
			if err != nil {
				return err
			}
			if script.PrototypeSurface == "" {
				return fmt.Errorf(
					"configured server %q is not a prototype surface",
					options.Script,
				)
			}
			options.ServedSurface = script.PrototypeSurface
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			credential, err := dependencies.Load()
			if err != nil {
				return fmt.Errorf("load connected machine credential: %w", err)
			}
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			return publishPullRequestDevServer(
				ctx,
				command.OutOrStdout(),
				manager,
				dependencies,
				credential,
				directory,
				options,
			)
		},
	}
	command.Flags().IntVar(&options.PullRequestNumber, "pr", 0, "pull request number")
	command.Flags().StringVar(&options.Repository, "repository", "", "GitHub owner/name")
	command.Flags().StringVar(&options.MachineID, "machine-id", "", "Project Space physical machine ID")
	command.Flags().StringVar(&options.ProjectID, "project-id", "", "connector inventory project ID")
	command.Flags().StringVar(&options.WorktreeID, "worktree-id", "", "connector inventory worktree ID")
	command.Flags().StringVar(
		&options.Script,
		"script",
		"prototype-desktop",
		"configured prototype server",
	)
	command.Flags().StringVar(
		&options.CodexThreadID,
		"codex-thread",
		"",
		"exact Codex task eligible to receive feedback",
	)
	command.Flags().StringVar(&options.BranchName, "branch", "", "expected checked-out branch")
	command.Flags().StringVar(&options.CommitSHA, "commit", "", "expected checked-out commit")
	for _, flag := range []string{"pr", "repository", "machine-id", "project-id", "worktree-id"} {
		_ = command.MarkFlagRequired(flag)
	}
	return command
}

func defaultPullRequestPublishDependencies() (pullRequestPublishDependencies, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return pullRequestPublishDependencies{}, fmt.Errorf("configure machine credential store: %w", err)
	}
	return pullRequestPublishDependencies{
		Client: &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
			Timeout: 10 * time.Second,
		},
		Load:  store.Load,
		Now:   time.Now,
		Sleep: waitForPullRequestHeartbeat,
		GitInfo: func(directory string) (string, string, error) {
			branch, err := runCommand(directory, nil, "git", "branch", "--show-current")
			if err != nil {
				return "", "", fmt.Errorf("read checked-out branch: %w", err)
			}
			commit, err := runCommand(directory, nil, "git", "rev-parse", "--verify", "HEAD")
			if err != nil {
				return "", "", fmt.Errorf("read checked-out commit: %w", err)
			}
			return strings.TrimSpace(branch), strings.TrimSpace(commit), nil
		},
	}, nil
}

func validatePullRequestPublishOptions(options pullRequestPublishOptions) error {
	if options.PullRequestNumber <= 0 {
		return errors.New("--pr must be positive")
	}
	if _, err := parseGitHubRepository(options.Repository); err != nil {
		return fmt.Errorf("--repository: %w", err)
	}
	for name, value := range map[string]string{
		"--machine-id":  options.MachineID,
		"--project-id":  options.ProjectID,
		"--worktree-id": options.WorktreeID,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s must not be empty", name)
		}
	}
	if err := projectrun.ValidateScriptName(options.Script); err != nil {
		return err
	}
	return nil
}

func publishPullRequestDevServer(
	ctx context.Context,
	output io.Writer,
	manager projectCommandManager,
	dependencies pullRequestPublishDependencies,
	credential machineconnect.Credential,
	directory string,
	options pullRequestPublishOptions,
) error {
	status, err := manager.Status(ctx, directory, options.Script)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return fmt.Errorf("inspect managed server: %w", err)
	}
	runtime, err := pullRequestRuntime(status, dependencies.Now())
	if err != nil {
		return err
	}
	registration := map[string]any{
		"branchName":         options.BranchName,
		"codexThreadId":      strings.TrimSpace(options.CodexThreadID),
		"commitSha":          options.CommitSHA,
		"connectorId":        credential.MachineID,
		"machineId":          options.MachineID,
		"projectId":          options.ProjectID,
		"pullRequestNumber":  options.PullRequestNumber,
		"repositoryFullName": options.Repository,
		"runtime":            runtime,
		"servedSurface":      options.ServedSurface,
		"serverId":           options.Script,
		"worktreeId":         options.WorktreeID,
	}
	if options.CodexThreadID == "" {
		delete(registration, "codexThreadId")
	}
	lease := pullRequestDevServerLease{}
	if err := postPullRequestLease(
		ctx, dependencies.Client, credential, "register", registration, &lease,
	); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return nil
		}
		return err
	}
	if err := validatePullRequestLease(lease, dependencies.Now()); err != nil {
		return err
	}
	fmt.Fprintf(
		output,
		"Live prototype published to PR #%d until %s. Press Ctrl-C to stop.\n",
		options.PullRequestNumber,
		lease.Lease.ExpiresAt,
	)
	defer func() {
		if err := releasePullRequestLease(dependencies, credential, options, lease); err != nil {
			fmt.Fprintf(output, "Warning: the live prototype lease could not be released immediately: %v\n", err)
		}
	}()

	interval := time.Duration(lease.HeartbeatIntervalSeconds) * time.Second
	for {
		if err := dependencies.Sleep(ctx, interval); err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		}
		status, err = manager.Status(ctx, directory, options.Script)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return fmt.Errorf("inspect managed server for heartbeat: %w", err)
		}
		runtime, err = pullRequestRuntime(status, dependencies.Now())
		if err != nil {
			return err
		}
		heartbeat := map[string]any{
			"connectorId":   credential.MachineID,
			"generation":    lease.Lease.Generation,
			"leaseId":       lease.Lease.ID,
			"machineId":     options.MachineID,
			"runtime":       runtime,
			"servedSurface": options.ServedSurface,
		}
		if err := postPullRequestLease(
			ctx, dependencies.Client, credential, "heartbeat", heartbeat, &lease,
		); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return err
		}
		if err := validatePullRequestLease(lease, dependencies.Now()); err != nil {
			return err
		}
	}
}

func pullRequestRuntime(status projectrun.ServeResult, now time.Time) (map[string]any, error) {
	if status.State != projectrun.StateRunning ||
		status.TailscaleIPv4 == nil ||
		status.PublicPort == nil ||
		status.PublicURL == nil {
		return nil, errors.New("managed server is not running on a verified Tailscale address")
	}
	return map[string]any{
		"checkedAt":     now.UTC().Format(time.RFC3339Nano),
		"state":         "running",
		"tailscaleIpv4": *status.TailscaleIPv4,
		"tailscalePort": *status.PublicPort,
	}, nil
}

func postPullRequestLease(
	ctx context.Context,
	client *http.Client,
	credential machineconnect.Credential,
	operation string,
	payload any,
	result any,
) error {
	base, err := url.Parse(credential.BackendURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return errors.New("connected machine credential has an invalid backend URL")
	}
	base.Path = pullRequestDevServerPath + operation
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode %s request: %w", operation, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create %s request: %w", operation, err)
	}
	request.Header.Set("Authorization", "Bearer "+credential.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("%s live prototype lease: %w", operation, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%s live prototype lease: Project Space returned HTTP %d", operation, response.StatusCode)
	}
	if result != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(result); err != nil {
			return fmt.Errorf("decode %s response: %w", operation, err)
		}
	}
	return nil
}

func releasePullRequestLease(
	dependencies pullRequestPublishDependencies,
	credential machineconnect.Credential,
	options pullRequestPublishOptions,
	lease pullRequestDevServerLease,
) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return postPullRequestLease(ctx, dependencies.Client, credential, "release", map[string]any{
		"connectorId": credential.MachineID,
		"generation":  lease.Lease.Generation,
		"leaseId":     lease.Lease.ID,
		"machineId":   options.MachineID,
	}, nil)
}

func validatePullRequestLease(lease pullRequestDevServerLease, now time.Time) error {
	if strings.TrimSpace(lease.Lease.ID) == "" ||
		lease.Lease.Generation <= 0 ||
		lease.HeartbeatIntervalSeconds <= 0 ||
		lease.HeartbeatIntervalSeconds > 30 {
		return errors.New("Project Space returned an invalid live prototype lease")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, lease.Lease.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return errors.New("Project Space returned an expired live prototype lease")
	}
	return nil
}

func waitForPullRequestHeartbeat(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func parseGitHubRepository(value string) (string, error) {
	parts := strings.Split(strings.TrimSpace(value), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", errors.New("expected owner/name")
	}
	return strings.Join(parts, "/"), nil
}
