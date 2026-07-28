package main

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"

	"github.com/DotNaos/project-space/internal/machinedirectory"
	"github.com/spf13/cobra"
)

func newCodexListCommand(
	dependencies machineDirectoryDependencies,
) *cobra.Command {
	filter := machinedirectory.ThreadFilter{}
	format := "text"
	command := &cobra.Command{
		Use:   "list",
		Short: "List account Codex tasks across known physical machines",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := requireTextOrJSON(format); err != nil {
				return err
			}
			if filter.MachineID != "" && filter.MachineName != "" {
				return errors.New("select a machine with --machine or --machine-id, not both")
			}
			loaded, err := dependencies.ListThreads(command.Context(), filter, false)
			if err != nil {
				return err
			}
			if format == "json" {
				return writeIndentedJSON(command.OutOrStdout(), loaded.Result)
			}
			return writeCodexThreadList(command.OutOrStdout(), loaded.Result)
		},
	}
	command.Flags().StringVar(&filter.MachineName, "machine", "", "exact physical machine name")
	command.Flags().StringVar(&filter.MachineID, "machine-id", "", "exact physical machine ID")
	command.Flags().StringVar(&filter.Search, "search", "", "search titles and project context")
	command.Flags().StringSliceVar(&filter.States, "state", nil, "task state filter (repeatable)")
	command.Flags().BoolVar(&filter.IncludeArchived, "archived", false, "include archived tasks")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	registerDirectoryCompletions(command, dependencies, nil)
	must(command.RegisterFlagCompletionFunc("format", fixedValuesCompletion("text", "json")))
	return command
}

func writeCodexThreadList(
	output io.Writer,
	result machinedirectory.ThreadsResult,
) error {
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(
		writer, "TITLE\tID\tMACHINE\tMACHINE ID\tSTATE\tUPDATED\tPROJECT",
	); err != nil {
		return err
	}
	for _, thread := range result.Threads {
		context := thread.Repository
		if context == "" {
			context = thread.Project
		}
		if context == "" {
			context = thread.CWD
		}
		if _, err := fmt.Fprintf(
			writer, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			oneLine(thread.Title), thread.ID, thread.Machine.Name, thread.Machine.ID,
			thread.State, thread.UpdatedAt, context,
		); err != nil {
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	if result.Partial {
		unavailable := make([]string, 0)
		for _, host := range result.Hosts {
			if host.InventoryState != "live" {
				unavailable = append(
					unavailable,
					fmt.Sprintf("%s/%s: %s", host.MachineName, host.ConnectorID, host.InventoryState),
				)
			}
		}
		_, err := fmt.Fprintf(
			output, "Partial task inventory: %s\n", strings.Join(unavailable, ", "),
		)
		return err
	}
	return nil
}

func oneLine(value string) string {
	return strings.Join(strings.Fields(value), " ")
}
