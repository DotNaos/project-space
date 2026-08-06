package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/worktreecheckout"
	"github.com/DotNaos/project-space/internal/worktreeownership"
	"github.com/spf13/cobra"
)

type githubIssue struct {
	Number int    `json:"number"`
	State  string `json:"state"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

func newWorktreeCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "worktree",
		Short: "Prepare and validate isolated Codex worktrees",
	}
	cmd.AddCommand(newWorktreePrepareCommand())
	cmd.AddCommand(newWorktreeCheckCommand())
	cmd.AddCommand(newWorktreeMaterializeCommand())
	cmd.AddCommand(newWorktreeRecoverCommand())
	return cmd
}

func newWorktreeRecoverCommand() *cobra.Command {
	var expectedOwner, format string
	cmd := &cobra.Command{
		Use:   "recover",
		Short: "Replace a confirmed orphaned Codex owner on a pristine managed worktree",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateWorktreeFormat(format); err != nil {
				return err
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			result, err := worktreeownership.Recover(worktreeownership.RecoverOptions{
				ExpectedOwnerThreadID: expectedOwner,
				ReplacementThreadID:   strings.TrimSpace(os.Getenv("CODEX_THREAD_ID")),
				StartPath:             cwd,
			})
			if err != nil {
				return err
			}
			return printWorktreeResult(cmd, result, "", format)
		},
	}
	cmd.Flags().StringVar(&expectedOwner, "expected-owner", "", "exact orphaned Codex thread id")
	cmd.Flags().StringVar(&format, "format", "text", "output format: text or json")
	_ = cmd.MarkFlagRequired("expected-owner")
	return cmd
}

type worktreeMaterializer func(context.Context, worktreecheckout.Request) (worktreecheckout.Result, error)

func newWorktreeMaterializeCommand() *cobra.Command {
	return newWorktreeMaterializeCommandWith(worktreecheckout.Materialize)
}

func newWorktreeMaterializeCommandWith(materialize worktreeMaterializer) *cobra.Command {
	var repository, branch, commit, format string
	cmd := &cobra.Command{
		Use:   "materialize",
		Short: "Materialize a server-approved GitHub branch in the Project-managed worktree root",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if format != "json" {
				return errors.New("--format must be json")
			}
			home, err := os.UserHomeDir()
			if err != nil {
				return fmt.Errorf("find home directory: %w", err)
			}
			result, err := materialize(cmd.Context(), worktreecheckout.Request{
				Repository: repository, Branch: branch, Commit: commit,
				WorktreesRoot: filepath.Join(home, "projects", ".worktrees"),
			})
			if err != nil {
				return err
			}
			return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
		},
	}
	cmd.Flags().StringVar(&repository, "repository", "", "server-approved GitHub owner/name")
	cmd.Flags().StringVar(&branch, "branch", "", "server-approved exact branch identity")
	cmd.Flags().StringVar(&commit, "commit", "", "server-approved exact commit")
	cmd.Flags().StringVar(&format, "format", "json", "output format: json")
	_ = cmd.MarkFlagRequired("repository")
	_ = cmd.MarkFlagRequired("branch")
	_ = cmd.MarkFlagRequired("commit")
	return cmd
}

func newWorktreePrepareCommand() *cobra.Command {
	issueNumber := 0
	format := "text"
	cmd := &cobra.Command{
		Use:   "prepare [task-name]",
		Short: "Prepare the worktree owned by the current Codex thread",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateWorktreeFormat(format); err != nil {
				return err
			}
			if issueNumber > 0 && len(args) > 0 {
				return errors.New("use either --issue or a task name, not both")
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			threadID := strings.TrimSpace(os.Getenv("CODEX_THREAD_ID"))
			if issueNumber == 0 && len(args) == 0 {
				result, claimErr := worktreeownership.Claim(worktreeownership.ClaimOptions{
					StartPath: cwd,
					ThreadID:  threadID,
				})
				if claimErr != nil {
					return claimErr
				}
				return printWorktreeResult(cmd, result, "", format)
			}
			options := worktreeownership.PrepareOptions{
				IssueNumber: issueNumber,
				StartPath:   cwd,
				ThreadID:    threadID,
			}
			issue := githubIssue{}
			if issueNumber > 0 {
				issue, err = readGitHubIssue(cwd, issueNumber)
				if err != nil {
					return err
				}
				options.IssueTitle = issue.Title
			} else {
				options.TaskName = args[0]
			}
			result, err := worktreeownership.Prepare(options)
			if err != nil {
				return err
			}
			return printWorktreeResult(cmd, result, issue.URL, format)
		},
	}
	cmd.Flags().IntVar(&issueNumber, "issue", 0, "prepare a worktree for an existing open GitHub issue")
	cmd.Flags().StringVar(&format, "format", "text", "output format: text or json")
	return cmd
}

func newWorktreeCheckCommand() *cobra.Command {
	format := "text"
	cmd := &cobra.Command{
		Use:   "check",
		Short: "Validate that the current Codex thread owns this isolated worktree",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateWorktreeFormat(format); err != nil {
				return err
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			result, err := worktreeownership.Check(worktreeownership.CheckOptions{
				StartPath: cwd,
				ThreadID:  strings.TrimSpace(os.Getenv("CODEX_THREAD_ID")),
			})
			if err != nil {
				return err
			}
			return printWorktreeResult(cmd, result, "", format)
		},
	}
	cmd.Flags().StringVar(&format, "format", "text", "output format: text or json")
	return cmd
}

func readGitHubIssue(directory string, number int) (githubIssue, error) {
	if number <= 0 {
		return githubIssue{}, errors.New("issue number must be positive")
	}
	output, err := runCommand(
		directory,
		nil,
		"gh",
		"issue",
		"view",
		strconv.Itoa(number),
		"--json",
		"number,state,title,url",
	)
	if err != nil {
		return githubIssue{}, fmt.Errorf("read GitHub issue #%d: %w", number, err)
	}
	issue := githubIssue{}
	if err := json.Unmarshal([]byte(output), &issue); err != nil {
		return githubIssue{}, fmt.Errorf("parse GitHub issue #%d: %w", number, err)
	}
	if issue.Number != number || strings.TrimSpace(issue.Title) == "" {
		return githubIssue{}, fmt.Errorf("GitHub issue #%d returned incomplete data", number)
	}
	if !strings.EqualFold(issue.State, "open") {
		return githubIssue{}, fmt.Errorf("GitHub issue #%d is not open", number)
	}
	return issue, nil
}

func validateWorktreeFormat(format string) error {
	if format != "text" && format != "json" {
		return errors.New("--format must be text or json")
	}
	return nil
}

func printWorktreeResult(cmd *cobra.Command, result worktreeownership.Result, issueURL string, format string) error {
	if format == "json" {
		payload := struct {
			worktreeownership.Result
			IssueURL string `json:"issueUrl,omitempty"`
		}{Result: result, IssueURL: issueURL}
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(payload)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Worktree %s: %s\n", result.Status, result.Path)
	fmt.Fprintf(cmd.OutOrStdout(), "Branch: %s\n", result.Branch)
	fmt.Fprintf(cmd.OutOrStdout(), "Owner thread: %s\n", result.Owner)
	if result.Issue > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "Issue: #%d", result.Issue)
		if issueURL != "" {
			fmt.Fprintf(cmd.OutOrStdout(), " (%s)", issueURL)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Next: cd %s\n", shellQuote(result.Path))
	return nil
}
