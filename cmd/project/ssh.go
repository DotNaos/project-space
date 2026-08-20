package main

import (
	"errors"
	"fmt"
	"sort"

	"github.com/DotNaos/project-space/internal/clientaccess"
	"github.com/DotNaos/project-space/internal/computeinventory"
	"github.com/spf13/cobra"
)

type sshCommandDependencies struct {
	Inventory computeInventoryCommandDependencies
	Access    clientaccess.Dependencies
}

func defaultSSHCommandDependencies() sshCommandDependencies {
	return sshCommandDependencies{
		Inventory: defaultComputeInventoryCommandDependencies(),
		Access:    clientaccess.DefaultDependencies(),
	}
}

func newSSHCommand() *cobra.Command {
	return newSSHCommandWithDependencies(defaultSSHCommandDependencies())
}

func newSSHCommandWithDependencies(dependencies sshCommandDependencies) *cobra.Command {
	var environmentID string
	command := &cobra.Command{
		Use:   "ssh [environment-instance]",
		Short: "Open a client-owned SSH session to a Tailscale Environment",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			selector := environmentID
			if len(args) == 1 {
				if selector != "" {
					return errors.New("use either an Environment selector or --environment-id, not both")
				}
				selector = args[0]
			}
			if selector == "" {
				return errors.New("an Environment selector or --environment-id is required")
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies.Inventory)
			if err != nil {
				return fmt.Errorf("load current compute inventory: %w", err)
			}
			if inventory.InventoryState == "conflict" {
				return &clientaccess.Failure{
					Phase: clientaccess.PhaseTarget, Code: clientaccess.CodeTargetUnavailable,
					Message: "the Compute inventory is conflicted; refresh it before selecting an Environment",
				}
			}
			var instance computeinventory.EnvironmentInstance
			if environmentID != "" {
				instance, err = resolveEnvironmentInstanceID(inventory.EnvironmentInstances, selector)
			} else {
				instance, err = resolveEnvironmentInstance(inventory.EnvironmentInstances, selector)
			}
			if err != nil {
				return err
			}
			route, err := selectClientAccessRoute(instance)
			if err != nil {
				return err
			}
			target, err := clientaccess.TargetFromRoute(route)
			if err != nil {
				return err
			}
			if err := clientaccess.Open(command.Context(), target, command.InOrStdin(), command.OutOrStdout(), command.ErrOrStderr(), dependencies.Access); err != nil {
				return fmt.Errorf("open client-owned SSH session to %s: %w", instance.Reference, err)
			}
			return nil
		},
	}
	command.Flags().StringVar(&environmentID, "environment-id", "", "exact Environment Instance ID")
	command.ValidArgsFunction = environmentCompletion
	return command
}

func selectClientAccessRoute(instance computeinventory.EnvironmentInstance) (computeinventory.AccessRoute, error) {
	eligible := make([]computeinventory.AccessRoute, 0)
	for _, route := range instance.AccessRoutes {
		if route.Type == "ssh_private_network" && route.ProviderKind == "tailscale" &&
			route.State == "ready" && route.ClientAccess != nil && hasInteractiveShellCapability(route.Capabilities) {
			eligible = append(eligible, route)
		}
	}
	if len(eligible) == 0 {
		return computeinventory.AccessRoute{}, &clientaccess.Failure{
			Phase: clientaccess.PhaseTarget, Code: clientaccess.CodeTargetUnavailable,
			Message: clientAccessUnavailableMessage(instance),
		}
	}
	priority := eligible[0].Priority
	for _, route := range eligible[1:] {
		if route.Priority > priority {
			priority = route.Priority
		}
	}
	preferred := eligible[:0]
	for _, route := range eligible {
		if route.Priority == priority {
			preferred = append(preferred, route)
		}
	}
	if len(preferred) != 1 {
		ids := make([]string, 0, len(preferred))
		for _, route := range preferred {
			ids = append(ids, route.ID)
		}
		sort.Strings(ids)
		return computeinventory.AccessRoute{}, &clientaccess.Failure{
			Phase: clientaccess.PhaseTarget, Code: clientaccess.CodeTargetUnavailable,
			Message: fmt.Sprintf("multiple verified Tailscale SSH routes are tied at priority %d: %v", priority, ids),
		}
	}
	return preferred[0], nil
}

func hasInteractiveShellCapability(capabilities []string) bool {
	for _, capability := range capabilities {
		if capability == "interactive_shell" {
			return true
		}
	}
	return false
}

func clientAccessUnavailableMessage(instance computeinventory.EnvironmentInstance) string {
	for _, route := range instance.AccessRoutes {
		if route.Type != "ssh_private_network" || route.ProviderKind != "tailscale" {
			continue
		}
		switch route.State {
		case "stale":
			return "the Environment Tailscale evidence is stale; refresh Compute before connecting"
		case "unverified":
			return "the Environment Tailscale route is not verified"
		case "unavailable", "policy_blocked":
			return "the Environment Tailscale SSH route is unavailable or policy-blocked"
		}
	}
	return "the Environment has no verified client-owned Tailscale SSH route"
}

func environmentCompletion(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
	return nil, cobra.ShellCompDirectiveNoFileComp
}
