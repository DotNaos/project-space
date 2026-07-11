package main

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
)

func printDeployResult(cmd *cobra.Command, project deployProject, options deployOptions) error {
	if options.Format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(project)
	}
	if options.Format != "pretty" {
		return fmt.Errorf("unknown format %q; use pretty or json", options.Format)
	}
	if options.DryRun {
		fmt.Fprintln(cmd.OutOrStdout(), "Deploy dry run")
	} else if project.Status == "success" {
		fmt.Fprintln(cmd.OutOrStdout(), "Deploy complete")
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Deploy %s\n", project.Status)
	}
	printDeployProjectSummary(cmd, project)
	if options.DryRun {
		fmt.Fprintln(cmd.OutOrStdout(), "\nRemote steps")
		for _, step := range project.Steps {
			fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", step)
		}
	}
	return nil
}

func printDeployStatusReport(cmd *cobra.Command, report deployStatusReport, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}
	if format != "pretty" {
		return fmt.Errorf("unknown format %q; use pretty or json", format)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Deploy status")
	fmt.Fprintf(cmd.OutOrStdout(), "Host: %s\n", report.Host)
	for _, project := range report.Environments {
		fmt.Fprintln(cmd.OutOrStdout())
		printDeployProjectSummary(cmd, project)
	}
	return nil
}

func printDeployProjectSummary(cmd *cobra.Command, project deployProject) {
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", project.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "Environment: %s\n", project.Environment)
	fmt.Fprintf(cmd.OutOrStdout(), "Remote path: %s\n", project.RemotePath)
	fmt.Fprintf(cmd.OutOrStdout(), "Branch: %s\n", project.Branch)
	fmt.Fprintf(cmd.OutOrStdout(), "Compose project: %s\n", project.ComposeProject)
	if project.Status != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Status: %s\n", project.Status)
	}
	if project.Evidence != nil {
		if project.Evidence.LockOwner != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Lock: %s at %s\n", project.Evidence.LockOwner, project.Evidence.LockAcquiredAt)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Remote checkout: %s\n", project.Evidence.RemoteCheckoutCommit)
		fmt.Fprintf(cmd.OutOrStdout(), "Running build: %s\n", project.Evidence.RunningBuildCommit)
		fmt.Fprintf(cmd.OutOrStdout(), "Services healthy: %t\n", project.Evidence.ComposeHealthy)
		fmt.Fprintf(cmd.OutOrStdout(), "HTTP healthy: %t\n", project.Evidence.HTTPHealthy)
		fmt.Fprintf(cmd.OutOrStdout(), "Live origin healthy: %t\n", project.Evidence.LiveOriginHealthy)
	}
	if project.WebURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Web: %s\n", project.WebURL)
	}
	if project.APIURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "API: %s\n", project.APIURL)
	}
	if project.DocsURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Docs: %s\n", project.DocsURL)
	}
}
