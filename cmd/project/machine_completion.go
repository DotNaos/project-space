package main

import (
	"fmt"
	"strings"

	"github.com/DotNaos/project-space/internal/machinedirectory"
	"github.com/spf13/cobra"
)

func machineNameCompletion(
	dependencies machineDirectoryDependencies,
) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return machineCompletion(dependencies, false)
}

func machineIDCompletion(
	dependencies machineDirectoryDependencies,
) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return machineCompletion(dependencies, true)
}

func machineCompletion(
	dependencies machineDirectoryDependencies,
	useID bool,
) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return func(
		command *cobra.Command,
		_ []string,
		_ string,
	) ([]string, cobra.ShellCompDirective) {
		loaded, err := dependencies.ListMachines(command.Context(), true)
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		values := make([]string, 0, len(loaded.Result.Machines))
		for _, machine := range loaded.Result.Machines {
			selector := machine.Name
			description := machine.ID
			if useID {
				selector, description = machine.ID, machine.Name
			}
			description += fmt.Sprintf(
				" (Tailscale %s; SSH %s; connector %s)",
				machine.Tailscale.State, machine.SSH.State, machine.Connector.State,
			)
			if loaded.Cached {
				description += " (cached evidence)"
			}
			values = append(values, selector+"\t"+description)
		}
		return values, cobra.ShellCompDirectiveNoFileComp
	}
}

func registerDirectoryCompletions(
	command *cobra.Command,
	dependencies machineDirectoryDependencies,
	target *codexTargetOptions,
) {
	must(command.RegisterFlagCompletionFunc("machine", machineNameCompletion(dependencies)))
	must(command.RegisterFlagCompletionFunc("machine-id", machineIDCompletion(dependencies)))
	if target != nil {
		must(command.RegisterFlagCompletionFunc(
			"thread", codexThreadCompletion(dependencies, target),
		))
	}
}

func codexThreadCompletion(
	dependencies machineDirectoryDependencies,
	target *codexTargetOptions,
) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return func(
		command *cobra.Command,
		_ []string,
		_ string,
	) ([]string, cobra.ShellCompDirective) {
		filter := machinedirectory.ThreadFilter{
			IncludeArchived: false,
			MachineID:       target.machineID,
			MachineName:     target.machineName,
		}
		loaded, err := dependencies.ListThreads(command.Context(), filter, true)
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		values := make([]string, 0, len(loaded.Result.Threads))
		for _, thread := range loaded.Result.Threads {
			description := fmt.Sprintf(
				"%s — %s on %s", oneLine(thread.Title), thread.State, thread.Machine.Name,
			)
			if context := firstNonempty(thread.Repository, thread.Project); context != "" {
				description += " — " + context
			}
			if loaded.Cached || thread.InventoryState != "live" {
				description += " (cached inventory)"
			}
			values = append(values, thread.ID+"\t"+description)
		}
		return values, cobra.ShellCompDirectiveNoFileComp
	}
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
