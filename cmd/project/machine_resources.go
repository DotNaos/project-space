package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/machineresources"
	"github.com/spf13/cobra"
)

type machineResourcesRuntime struct {
	api        machineresources.API
	credential machineconnect.Credential
}

type machineResourcesCommandDependencies struct {
	LoadRuntime func(context.Context) (machineResourcesRuntime, error)
	Wait        func(context.Context, time.Duration) error
}

type machineResourceTarget struct {
	context string
	here    bool
	machine string
}

func newMachineResourcesCommand(dependencies machineResourcesCommandDependencies) *cobra.Command {
	dependencies = normalizeMachineResourcesDependencies(dependencies)
	command := &cobra.Command{
		Use:   "resources",
		Short: "Inspect CPU, GPU, memory, and disk utilization",
	}
	command.AddCommand(newMachineResourcesListCommand(dependencies))
	command.AddCommand(newMachineResourcesShowCommand(dependencies))
	command.AddCommand(newMachineResourcesWatchCommand(dependencies))
	return command
}

func normalizeMachineResourcesDependencies(
	dependencies machineResourcesCommandDependencies,
) machineResourcesCommandDependencies {
	if dependencies.LoadRuntime == nil {
		dependencies.LoadRuntime = loadMachineResourcesRuntime
	}
	if dependencies.Wait == nil {
		dependencies.Wait = func(ctx context.Context, duration time.Duration) error {
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
	}
	return dependencies
}

func loadMachineResourcesRuntime(context.Context) (machineResourcesRuntime, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil || store == nil {
		return machineResourcesRuntime{}, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return machineResourcesRuntime{}, errors.New("this machine is not connected to Project Space")
	}
	client, err := machineresources.NewClient(machineresources.Config{
		BaseURL: credential.BackendURL, CallerMachineID: credential.MachineID, Token: credential.Token,
	})
	if err != nil {
		return machineResourcesRuntime{}, err
	}
	return machineResourcesRuntime{api: client, credential: credential}, nil
}

func newMachineResourcesListCommand(dependencies machineResourcesCommandDependencies) *cobra.Command {
	format := "text"
	command := &cobra.Command{
		Use:   "list",
		Short: "List the latest resource state for accessible machine contexts",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateMachineResourceFormat(format); err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			result, err := runtime.api.List(command.Context())
			if err != nil {
				return err
			}
			sortMachineResources(result.Machines)
			if format == "json" {
				return writeMachineResourcesJSON(command.OutOrStdout(), result)
			}
			writeMachineResourcesList(command.OutOrStdout(), result)
			return nil
		},
	}
	addMachineResourceFormatFlag(command, &format)
	return command
}

func newMachineResourcesShowCommand(dependencies machineResourcesCommandDependencies) *cobra.Command {
	target := machineResourceTarget{}
	format := "text"
	command := &cobra.Command{
		Use:   "show",
		Short: "Show one machine context resource snapshot",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateMachineResourceFormat(format); err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			selector, err := target.selector(runtime.credential)
			if err != nil {
				return err
			}
			result, err := runtime.api.List(command.Context())
			if err != nil {
				return err
			}
			machine, err := selectMachineResource(result.Machines, selector, target.context)
			if err != nil {
				return err
			}
			selected := machineresources.Result{CheckedAt: result.CheckedAt, Machines: []machineresources.Machine{machine}}
			if format == "json" {
				return writeMachineResourcesJSON(command.OutOrStdout(), selected)
			}
			writeMachineResourceShow(command.OutOrStdout(), machine)
			return nil
		},
	}
	addMachineResourceTargetFlags(command, &target)
	addMachineResourceFormatFlag(command, &format)
	return command
}

func newMachineResourcesWatchCommand(dependencies machineResourcesCommandDependencies) *cobra.Command {
	target := machineResourceTarget{}
	format := "text"
	command := &cobra.Command{
		Use:   "watch",
		Short: "Continuously watch one machine context resource snapshot",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateMachineResourceFormat(format); err != nil {
				return err
			}
			runtime, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			selector, err := target.selector(runtime.credential)
			if err != nil {
				return err
			}
			first := true
			for {
				result, err := runtime.api.List(command.Context())
				if err != nil {
					if errors.Is(err, context.Canceled) {
						return nil
					}
					return err
				}
				machine, err := selectMachineResource(result.Machines, selector, target.context)
				if err != nil {
					return err
				}
				if format == "json" {
					if err := writeMachineResourcesJSON(command.OutOrStdout(), machineresources.Result{
						CheckedAt: result.CheckedAt, Machines: []machineresources.Machine{machine},
					}); err != nil {
						return err
					}
				} else {
					if !first {
						_, _ = io.WriteString(command.OutOrStdout(), "\x1b[H\x1b[2J")
					}
					writeMachineResourceShow(command.OutOrStdout(), machine)
				}
				first = false
				if err := dependencies.Wait(command.Context(), 2*time.Second); err != nil {
					if errors.Is(err, context.Canceled) {
						return nil
					}
					return err
				}
			}
		},
	}
	addMachineResourceTargetFlags(command, &target)
	addMachineResourceFormatFlag(command, &format)
	return command
}

func addMachineResourceTargetFlags(command *cobra.Command, target *machineResourceTarget) {
	command.Flags().BoolVar(&target.here, "here", false, "use the machine connected by this CLI")
	command.Flags().StringVar(&target.machine, "machine", "", "exact machine ID or name")
	command.Flags().StringVar(&target.context, "context", "", "exact context ID or label")
}

func addMachineResourceFormatFlag(command *cobra.Command, format *string) {
	command.Flags().StringVar(format, "format", "text", "output format: text or json")
	must(command.RegisterFlagCompletionFunc("format", fixedValuesCompletion("text", "json")))
}

func validateMachineResourceFormat(format string) error {
	if format != "text" && format != "json" {
		return errors.New("--format must be text or json")
	}
	return nil
}

func (target machineResourceTarget) selector(credential machineconnect.Credential) (string, error) {
	if target.here && target.machine != "" {
		return "", errors.New("--here and --machine cannot be used together")
	}
	if target.here {
		return credential.MachineID, nil
	}
	if strings.TrimSpace(target.machine) == "" {
		return "", errors.New("use --here or --machine <id-or-name>")
	}
	return target.machine, nil
}

func selectMachineResource(
	machines []machineresources.Machine,
	selector string,
	contextSelector string,
) (machineresources.Machine, error) {
	matches := make([]machineresources.Machine, 0)
	for _, machine := range machines {
		if matchesMachineResource(machine, selector) {
			matches = append(matches, machine)
		}
	}
	if len(matches) == 0 {
		return machineresources.Machine{}, fmt.Errorf("machine %q was not found", selector)
	}
	identities := map[string]struct{}{}
	for _, machine := range matches {
		identity := machine.PhysicalMachineID
		if identity == "" {
			identity = machine.MachineID
		}
		identities[identity] = struct{}{}
	}
	if len(identities) > 1 {
		return machineresources.Machine{}, fmt.Errorf("machine %q is ambiguous; use an exact machine ID", selector)
	}
	if contextSelector != "" {
		contextMatches := matches[:0]
		for _, machine := range matches {
			if machine.Context.ID == contextSelector ||
				(machine.Context.Label != "" && strings.EqualFold(machine.Context.Label, contextSelector)) {
				contextMatches = append(contextMatches, machine)
			}
		}
		switch len(contextMatches) {
		case 0:
			return machineresources.Machine{}, fmt.Errorf(
				"context %q was not found for machine %q", contextSelector, selector,
			)
		case 1:
			return contextMatches[0], nil
		default:
			return machineresources.Machine{}, fmt.Errorf(
				"context %q is ambiguous; use an exact context ID", contextSelector,
			)
		}
	}
	if len(matches) > 1 {
		return machineresources.Machine{}, fmt.Errorf(
			"machine %q has multiple contexts; use --context <id-or-label>", selector,
		)
	}
	return matches[0], nil
}

func matchesMachineResource(machine machineresources.Machine, selector string) bool {
	return machine.MachineID == selector || machine.PhysicalMachineID == selector ||
		strings.EqualFold(machine.MachineName, selector) ||
		(machine.PhysicalMachineName != "" && strings.EqualFold(machine.PhysicalMachineName, selector))
}

func sortMachineResources(machines []machineresources.Machine) {
	sort.SliceStable(machines, func(left, right int) bool {
		leftName := machines[left].PhysicalMachineName
		if leftName == "" {
			leftName = machines[left].MachineName
		}
		rightName := machines[right].PhysicalMachineName
		if rightName == "" {
			rightName = machines[right].MachineName
		}
		if !strings.EqualFold(leftName, rightName) {
			return strings.ToLower(leftName) < strings.ToLower(rightName)
		}
		return strings.ToLower(resourceContextLabel(machines[left])) <
			strings.ToLower(resourceContextLabel(machines[right]))
	})
}

func writeMachineResourcesJSON(writer io.Writer, result machineresources.Result) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(result)
}

func writeMachineResourcesList(writer io.Writer, result machineresources.Result) {
	table := tabwriter.NewWriter(writer, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(table, "MACHINE\tCONTEXT\tSTATE\tCPU\tMEMORY\tDISK\tGPU")
	for _, machine := range result.Machines {
		name := machine.PhysicalMachineName
		if name == "" {
			name = machine.MachineName
		}
		_, _ = fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			name, resourceContextLabel(machine), machine.State,
			formatResourceMetric(machine.Metrics.CPU),
			formatResourceMetric(machine.Metrics.Memory),
			formatResourceMetric(machine.Metrics.Disk),
			formatResourceMetric(machine.Metrics.GPU),
		)
	}
	_ = table.Flush()
}

func writeMachineResourceShow(writer io.Writer, machine machineresources.Machine) {
	name := machine.PhysicalMachineName
	if name == "" {
		name = machine.MachineName
	}
	table := tabwriter.NewWriter(writer, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintf(table, "Machine:\t%s\nContext:\t%s\nState:\t%s\n",
		name, resourceContextLabel(machine), machine.State)
	if machine.SampledAt != "" {
		_, _ = fmt.Fprintf(table, "Sampled:\t%s\n", machine.SampledAt)
	}
	_, _ = fmt.Fprintf(table, "CPU:\t%s\nMemory:\t%s\nDisk:\t%s\nGPU:\t%s\n",
		formatResourceMetric(machine.Metrics.CPU),
		formatResourceMetric(machine.Metrics.Memory),
		formatResourceMetric(machine.Metrics.Disk),
		formatResourceMetric(machine.Metrics.GPU),
	)
	_ = table.Flush()
}

func resourceContextLabel(machine machineresources.Machine) string {
	if machine.Context.Label != "" {
		return machine.Context.Label
	}
	return machine.Context.ID
}

func formatResourceMetric(metric machineresources.Metric) string {
	if metric.State != machineresources.MetricAvailable {
		if metric.Message != "" {
			return fmt.Sprintf("%s (%s)", metric.State, metric.Message)
		}
		return string(metric.State)
	}
	parts := make([]string, 0, 2)
	if metric.UtilizationPercent != nil {
		parts = append(parts, fmt.Sprintf("%.0f%%", *metric.UtilizationPercent))
	}
	if metric.UsedBytes != nil && metric.TotalBytes != nil {
		parts = append(parts, fmt.Sprintf("%s / %s",
			formatResourceBytes(*metric.UsedBytes), formatResourceBytes(*metric.TotalBytes)))
	}
	if len(parts) == 0 {
		return "available"
	}
	return strings.Join(parts, " · ")
}

func formatResourceBytes(value int64) string {
	const unit = int64(1024)
	if value < unit {
		return fmt.Sprintf("%d B", value)
	}
	divisor, exponent := unit, 0
	for reduced := value / unit; reduced >= unit && exponent < 5; reduced /= unit {
		divisor *= unit
		exponent++
	}
	return fmt.Sprintf("%.1f %ciB", float64(value)/float64(divisor), "KMGTPE"[exponent])
}
