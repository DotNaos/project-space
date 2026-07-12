package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/DotNaos/project-space/internal/approval"
	"github.com/DotNaos/project-space/internal/approvalsigner"
	"github.com/spf13/cobra"
)

const defaultApprovalPolicy = ".project/approvals/policy.yaml"

type approvalOptions struct{ root, policy, trustRoot, checkpoint, format string }

var newApprovalSigner = func() approval.SignatureProvider { return approvalsigner.New() }

func newApprovalCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "approval", Short: "Manage cryptographic human approvals"}
	cmd.AddCommand(newApprovalPrepareCommand(), newApprovalStatusCommand(), newApprovalVerifyCommand(), newApprovalSignCommand(), newApprovalRevokeCommand(), newApprovalEnrollCommand())
	return cmd
}

func addApprovalFlags(cmd *cobra.Command, options *approvalOptions) {
	cmd.Flags().StringVar(&options.root, "root", ".", "repository root")
	cmd.Flags().StringVar(&options.policy, "policy", defaultApprovalPolicy, "repository approval policy")
	cmd.Flags().StringVar(&options.trustRoot, "trust-root", os.Getenv("PROJECT_APPROVAL_TRUST_ROOT"), "external trusted signer configuration")
	cmd.Flags().StringVar(&options.checkpoint, "checkpoint", os.Getenv("PROJECT_APPROVAL_CHECKPOINT"), "external latest accepted approval checkpoint")
	cmd.Flags().StringVar(&options.format, "format", "pretty", "output format: pretty or json")
}

func validateApprovalOptions(options approvalOptions) error {
	if options.trustRoot == "" {
		return fmt.Errorf("--trust-root or PROJECT_APPROVAL_TRUST_ROOT is required; repository keys are not a trust root")
	}
	if options.format != "pretty" && options.format != "json" {
		return fmt.Errorf("--format must be pretty or json")
	}
	return nil
}

func newApprovalStatusCommand() *cobra.Command {
	return newApprovalCheckCommand("status", "Show approval state", false)
}
func newApprovalVerifyCommand() *cobra.Command {
	return newApprovalCheckCommand("verify", "Verify every required human approval", true)
}

func newApprovalCheckCommand(use, short string, strict bool) *cobra.Command {
	options := approvalOptions{}
	cmd := &cobra.Command{Use: use, Short: short, Args: cobra.NoArgs}
	addApprovalFlags(cmd, &options)
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if err := validateApprovalOptions(options); err != nil {
			return err
		}
		root, err := filepath.Abs(options.root)
		if err != nil {
			return err
		}
		report, err := approval.VerifyWithCheckpoint(root, options.policy, options.trustRoot, options.checkpoint)
		if err != nil {
			return err
		}
		printApprovalReport(cmd, report, options.format)
		if strict && !report.OK {
			return fmt.Errorf("one or more required human approvals are not valid")
		}
		return nil
	}
	return cmd
}

func newApprovalSignCommand() *cobra.Command {
	return newApprovalOperationCommand("sign", "Approve one scope using Secure Enclave authentication", approval.OperationApprove)
}

func newApprovalRevokeCommand() *cobra.Command {
	return newApprovalOperationCommand("revoke", "Revoke one approved scope using Secure Enclave authentication", approval.OperationRevoke)
}

func newApprovalOperationCommand(use, short, operation string) *cobra.Command {
	options := approvalOptions{}
	scope := ""
	expectedContentDigest := ""
	cmd := &cobra.Command{Use: use, Short: short, Args: cobra.NoArgs}
	addApprovalFlags(cmd, &options)
	cmd.Flags().StringVar(&scope, "scope", "", "repository-declared scope identifier")
	cmd.Flags().StringVar(&expectedContentDigest, "expected-content-digest", "", "prepared content digest that must still match")
	_ = cmd.MarkFlagRequired("scope")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if err := validateApprovalOptions(options); err != nil {
			return err
		}
		root, err := filepath.Abs(options.root)
		if err != nil {
			return err
		}
		result, err := approval.ApplyOperation(root, options.policy, options.trustRoot, options.checkpoint, scope, operation, expectedContentDigest, newApprovalSigner())
		if err != nil {
			return err
		}
		if options.format == "json" {
			return json.NewEncoder(cmd.OutOrStdout()).Encode(result)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s %s sequence=%d digest=%s\n", strings.ToUpper(result.Operation), result.Attestation, result.Sequence, result.EventDigest)
		return nil
	}
	return cmd
}

func newApprovalPrepareCommand() *cobra.Command {
	options := approvalOptions{}
	scope := ""
	cmd := &cobra.Command{Use: "prepare", Short: "Inspect trusted signing inputs for one scope", Args: cobra.NoArgs}
	addApprovalFlags(cmd, &options)
	cmd.Flags().StringVar(&scope, "scope", "", "repository-declared scope identifier")
	_ = cmd.MarkFlagRequired("scope")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if err := validateApprovalOptions(options); err != nil {
			return err
		}
		root, err := filepath.Abs(options.root)
		if err != nil {
			return err
		}
		prepared, err := approval.Prepare(root, options.policy, options.trustRoot, options.checkpoint, scope)
		if err != nil {
			return err
		}
		if options.format == "json" {
			return json.NewEncoder(cmd.OutOrStdout()).Encode(prepared)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "%s\t%s\t%s\t%s\n", prepared.State, prepared.Scope.ID, prepared.ContentDigest, prepared.SignerID)
		return nil
	}
	return cmd
}

func newApprovalEnrollCommand() *cobra.Command {
	options := approvalOptions{}
	cmd := &cobra.Command{Use: "enroll", Short: "Create an external trusted signer configuration with macOS authentication", Args: cobra.NoArgs}
	addApprovalFlags(cmd, &options)
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if err := validateApprovalOptions(options); err != nil {
			return err
		}
		root, err := filepath.Abs(options.root)
		if err != nil {
			return err
		}
		trusted, err := approval.EnrollTrustRoot(root, options.policy, options.trustRoot, newApprovalSigner())
		if err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "ENROLLED %s for %s\n", trusted.SignerID, trusted.Repository)
		return nil
	}
	return cmd
}

func printApprovalReport(cmd *cobra.Command, report approval.Report, format string) {
	if format == "json" {
		_ = json.NewEncoder(cmd.OutOrStdout()).Encode(report)
		return
	}
	for _, scope := range report.Scopes {
		fmt.Fprintf(cmd.OutOrStdout(), "%s\t%s\t%s", scope.State, scope.ID, scope.Label)
		if scope.Reason != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "\t%s", scope.Reason)
		}
		fmt.Fprintln(cmd.OutOrStdout())
	}
	if report.OK {
		fmt.Fprintln(cmd.OutOrStdout(), "APPROVALS OK")
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "APPROVALS FAILED")
	}
}
