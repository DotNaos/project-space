package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/DotNaos/project-space/internal/machinedirectory"
	"github.com/spf13/cobra"
)

type machineSelection struct {
	ID   string
	Name string
}

type machineStatusResult struct {
	CheckedAt     string                     `json:"checkedAt"`
	Failures      []machinedirectory.Failure `json:"failures"`
	Machine       machinedirectory.Machine   `json:"machine"`
	SchemaVersion int                        `json:"schemaVersion"`
}

func newMachineCommand() *cobra.Command {
	return newMachineCommandWithDependencies(defaultMachineDirectoryDependencies())
}

func newMachineCommandWithDependencies(
	dependencies machineDirectoryDependencies,
) *cobra.Command {
	command := &cobra.Command{
		Use:   "machine",
		Short: "Discover physical machines and open SSH sessions",
	}
	command.AddCommand(newMachineListCommand(dependencies))
	command.AddCommand(newMachineStatusDirectoryCommand(dependencies))
	command.AddCommand(newMachineSSHCommand(dependencies))
	return command
}

func newMachineListCommand(dependencies machineDirectoryDependencies) *cobra.Command {
	format := "text"
	command := &cobra.Command{
		Use:   "list",
		Short: "List account machines and their independent readiness signals",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := requireTextOrJSON(format); err != nil {
				return err
			}
			loaded, err := dependencies.ListMachines(command.Context(), false)
			if err != nil {
				return err
			}
			if format == "json" {
				return writeIndentedJSON(command.OutOrStdout(), loaded.Result)
			}
			return writeMachineList(command.OutOrStdout(), loaded.Result)
		},
	}
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	must(command.RegisterFlagCompletionFunc("format", fixedValuesCompletion("text", "json")))
	return command
}

func newMachineStatusDirectoryCommand(
	dependencies machineDirectoryDependencies,
) *cobra.Command {
	selection, format := machineSelection{}, "text"
	command := &cobra.Command{
		Use:   "status",
		Short: "Show evidence for one physical machine",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := requireTextOrJSON(format); err != nil {
				return err
			}
			loaded, err := dependencies.ListMachines(command.Context(), false)
			if err != nil {
				return err
			}
			machine, err := resolveMachineSelection(loaded.Result.Machines, selection)
			if err != nil {
				return err
			}
			result := machineStatusResult{
				CheckedAt: loaded.Result.CheckedAt,
				Failures:  failuresForMachine(loaded.Result.Failures, machine.ID),
				Machine:   machine, SchemaVersion: 1,
			}
			if format == "json" {
				return writeIndentedJSON(command.OutOrStdout(), result)
			}
			return writeMachineStatus(command.OutOrStdout(), result)
		},
	}
	addMachineSelectionFlags(command, &selection, dependencies)
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	must(command.RegisterFlagCompletionFunc("format", fixedValuesCompletion("text", "json")))
	return command
}

func newMachineSSHCommand(dependencies machineDirectoryDependencies) *cobra.Command {
	selection := machineSelection{}
	command := &cobra.Command{
		Use:   "ssh",
		Short: "Open an interactive SSH terminal to a reachable physical machine",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			loaded, err := dependencies.ListMachines(command.Context(), false)
			if err != nil {
				return err
			}
			machine, err := resolveMachineSelection(loaded.Result.Machines, selection)
			if err != nil {
				return err
			}
			connection, err := dependencies.ResolveSSH(command.Context(), machine.ID)
			if err != nil {
				return err
			}
			return dependencies.RunSSH(connection.Target)
		},
	}
	addMachineSelectionFlags(command, &selection, dependencies)
	return command
}

func addMachineSelectionFlags(
	command *cobra.Command,
	selection *machineSelection,
	dependencies machineDirectoryDependencies,
) {
	command.Flags().StringVar(&selection.Name, "machine", "", "exact physical machine name")
	command.Flags().StringVar(&selection.ID, "machine-id", "", "exact physical machine ID")
	must(command.RegisterFlagCompletionFunc(
		"machine", machineNameCompletion(dependencies),
	))
	must(command.RegisterFlagCompletionFunc(
		"machine-id", machineIDCompletion(dependencies),
	))
}

func resolveMachineSelection(
	machines []machinedirectory.Machine,
	selection machineSelection,
) (machinedirectory.Machine, error) {
	if selection.ID != "" && selection.Name != "" {
		return machinedirectory.Machine{}, errors.New(
			"select a machine with --machine or --machine-id, not both",
		)
	}
	if selection.ID == "" && selection.Name == "" {
		return machinedirectory.Machine{}, errors.New("--machine or --machine-id is required")
	}
	matches := make([]machinedirectory.Machine, 0, 1)
	for _, machine := range machines {
		if selection.ID != "" && machine.ID == selection.ID ||
			selection.Name != "" && machine.Name == selection.Name {
			matches = append(matches, machine)
		}
	}
	if len(matches) == 0 {
		return machinedirectory.Machine{}, errors.New(
			"the selected physical machine is unavailable or not authorized",
		)
	}
	if len(matches) > 1 {
		return machinedirectory.Machine{}, errors.New(
			"more than one physical machine has this name; use --machine-id",
		)
	}
	return matches[0], nil
}

func writeMachineList(output io.Writer, result machinedirectory.MachinesResult) error {
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(
		writer, "NAME\tID\tTAILSCALE\tSSH\tCONNECTOR\tAPP SERVER\tLAST SEEN",
	); err != nil {
		return err
	}
	for _, machine := range result.Machines {
		if _, err := fmt.Fprintf(
			writer, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			machine.Name, machine.ID, machine.Tailscale.State, machine.SSH.State,
			machine.Connector.State, machine.CodexAppServer.State,
			machineLastSeen(machine),
		); err != nil {
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	for _, failure := range result.Failures {
		if _, err := fmt.Fprintf(
			output, "Partial evidence for %s (%s): %s\n",
			failure.MachineID, failure.Source, failure.Message,
		); err != nil {
			return err
		}
	}
	return nil
}

func writeMachineStatus(output io.Writer, result machineStatusResult) error {
	machine := result.Machine
	if _, err := fmt.Fprintf(output, "Machine: %s\nID: %s\n", machine.Name, machine.ID); err != nil {
		return err
	}
	for _, item := range []struct {
		label  string
		signal machinedirectory.Signal
	}{
		{"Tailscale", machine.Tailscale},
		{"SSH", machine.SSH},
		{"Connector", machine.Connector.Signal},
		{"Codex App Server", machine.CodexAppServer},
		{"Enrollment", machine.Enrollment},
	} {
		if _, err := fmt.Fprintf(
			output, "%s: %s%s\n", item.label, item.signal.State,
			evidenceSuffix(item.signal),
		); err != nil {
			return err
		}
	}
	for _, failure := range result.Failures {
		if _, err := fmt.Fprintf(output, "Partial evidence (%s): %s\n", failure.Source, failure.Message); err != nil {
			return err
		}
	}
	return nil
}

func machineLastSeen(machine machinedirectory.Machine) string {
	newest := ""
	newestTime := time.Time{}
	for _, value := range []string{
		machine.Tailscale.LastSeenAt, machine.SSH.LastSeenAt,
		machine.Connector.LastSeenAt, machine.CodexAppServer.LastSeenAt,
		machine.Enrollment.LastSeenAt,
	} {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err == nil && parsed.After(newestTime) {
			newest, newestTime = value, parsed
		}
	}
	if newest != "" {
		return newest
	}
	return "unknown"
}

func evidenceSuffix(signal machinedirectory.Signal) string {
	parts := make([]string, 0, 2)
	if signal.LastSeenAt != "" {
		parts = append(parts, "last seen "+signal.LastSeenAt)
	}
	if signal.Message != "" {
		parts = append(parts, signal.Message)
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, "; ") + ")"
}

func failuresForMachine(
	failures []machinedirectory.Failure,
	machineID string,
) []machinedirectory.Failure {
	selected := make([]machinedirectory.Failure, 0)
	for _, failure := range failures {
		if failure.MachineID == machineID {
			selected = append(selected, failure)
		}
	}
	return selected
}

func requireTextOrJSON(format string) error {
	if format != "text" && format != "json" {
		return errors.New("--format must be text or json")
	}
	return nil
}

func writeIndentedJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
