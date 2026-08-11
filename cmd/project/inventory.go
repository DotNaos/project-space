package main

import (
	"context"
	"errors"

	"github.com/DotNaos/project-space/internal/computeinventory"
	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type computeInventoryCommandDependencies struct {
	Load func(context.Context) (computeinventory.API, error)
}

type inventoryFormatOptions struct {
	format string
	json   bool
}

func defaultComputeInventoryCommandDependencies() computeInventoryCommandDependencies {
	return computeInventoryCommandDependencies{Load: loadComputeInventoryClient}
}

func loadComputeInventoryClient(context.Context) (computeinventory.API, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return nil, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return nil, errors.New("this machine is not connected to Project Space")
	}
	token := credential.Token
	return computeinventory.NewClient(computeinventory.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: computeinventory.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
}

func newInventoryCommand() *cobra.Command {
	return newInventoryCommandWithDependencies(defaultComputeInventoryCommandDependencies())
}

func newInventoryCommandWithDependencies(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use:   "inventory",
		Short: "Discover the complete compute inventory",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), inventory)
			}
			return writeInventorySummary(command.OutOrStdout(), inventory)
		},
	}
	options.addFlags(command, true)
	return command
}

func newPlatformCommand() *cobra.Command {
	return newPlatformCommandWithDependencies(defaultComputeInventoryCommandDependencies())
}

func newPlatformCommandWithDependencies(dependencies computeInventoryCommandDependencies) *cobra.Command {
	command := &cobra.Command{Use: "platform", Short: "Discover compute capacity providers"}
	command.AddCommand(newPlatformListCommand(dependencies))
	command.AddCommand(newPlatformShowCommand(dependencies))
	return command
}

func newPlatformListCommand(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use: "list", Short: "List configured compute platforms", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), platformListResult(inventory, inventory.Platforms))
			}
			return writePlatforms(command.OutOrStdout(), inventory.Platforms)
		},
	}
	options.addFlags(command, false)
	return command
}

func newPlatformShowCommand(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use: "show <platform>", Short: "Show one exact compute platform", Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			platform, err := resolvePlatform(inventory.Platforms, args[0])
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), platformShowResult(inventory, platform))
			}
			return writePlatforms(command.OutOrStdout(), []computeinventory.Platform{platform})
		},
	}
	options.addFlags(command, false)
	return command
}

func newHostCommand() *cobra.Command {
	return newHostCommandWithDependencies(defaultComputeInventoryCommandDependencies())
}

func newHostCommandWithDependencies(dependencies computeInventoryCommandDependencies) *cobra.Command {
	command := &cobra.Command{Use: "host", Short: "Discover physical or virtual hosts"}
	command.AddCommand(newHostListCommand(dependencies, false))
	command.AddCommand(newHostShowCommand(dependencies, false))
	return command
}

func newHostListCommand(dependencies computeInventoryCommandDependencies, compatibility bool) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	platformSelector := ""
	command := &cobra.Command{
		Use: "list", Short: "List inventory hosts", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if compatibility {
				writeMachineDeprecation(command.ErrOrStderr())
			}
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			hosts := inventory.Hosts
			if platformSelector != "" {
				platform, resolveErr := resolvePlatform(inventory.Platforms, platformSelector)
				if resolveErr != nil {
					return resolveErr
				}
				hosts = filterHostsByPlatform(hosts, platform.ID)
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), hostListResult(inventory, hosts))
			}
			return writeHosts(command.OutOrStdout(), hosts)
		},
	}
	if compatibility {
		command.Short = "Deprecated compatibility: list inventory hosts"
	}
	options.addFlags(command, false)
	command.Flags().StringVar(&platformSelector, "platform", "", "exact platform ID, name, kind, or alias")
	return command
}

func newHostShowCommand(dependencies computeInventoryCommandDependencies, compatibility bool) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use: "show <host>", Short: "Show one exact inventory host", Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if compatibility {
				writeMachineDeprecation(command.ErrOrStderr())
			}
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			host, err := resolveHost(inventory.Hosts, args[0])
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), hostShowResult(inventory, host))
			}
			return writeHosts(command.OutOrStdout(), []computeinventory.Host{host})
		},
	}
	if compatibility {
		command.Short = "Deprecated compatibility: show one inventory host"
	}
	options.addFlags(command, false)
	return command
}

func newEnvironmentCommand() *cobra.Command {
	return newEnvironmentCommandWithDependencies(defaultComputeInventoryCommandDependencies())
}

func newEnvironmentCommandWithDependencies(dependencies computeInventoryCommandDependencies) *cobra.Command {
	command := &cobra.Command{Use: "environment", Short: "Discover Environment definitions and instances"}
	command.AddCommand(newEnvironmentListCommand(dependencies))
	command.AddCommand(newEnvironmentShowCommand(dependencies))
	instance := &cobra.Command{Use: "instance", Short: "Discover concrete Environment Instances"}
	instance.AddCommand(newEnvironmentInstanceListCommand(dependencies))
	instance.AddCommand(newEnvironmentInstanceShowCommand(dependencies))
	command.AddCommand(instance)
	return command
}

func newEnvironmentListCommand(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use: "list", Short: "List reusable Environment definitions", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), definitionListResult(inventory, inventory.EnvironmentCatalog))
			}
			return writeDefinitions(command.OutOrStdout(), inventory.EnvironmentCatalog)
		},
	}
	options.addFlags(command, false)
	return command
}

func newEnvironmentShowCommand(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use: "show <environment-definition>", Short: "Show one Environment definition", Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			definition, err := resolveDefinition(inventory.EnvironmentCatalog, args[0])
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), definitionShowResult(inventory, definition))
			}
			return writeDefinitions(command.OutOrStdout(), []computeinventory.EnvironmentDefinition{definition})
		},
	}
	options.addFlags(command, false)
	return command
}

func newEnvironmentInstanceListCommand(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	platformSelector, hostSelector, definitionSelector := "", "", ""
	command := &cobra.Command{
		Use: "list", Short: "List concrete Environment Instances", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			instances := inventory.EnvironmentInstances
			if platformSelector != "" {
				platform, resolveErr := resolvePlatform(inventory.Platforms, platformSelector)
				if resolveErr != nil {
					return resolveErr
				}
				instances = filterInstances(instances, func(instance computeinventory.EnvironmentInstance) bool { return instance.PlatformID == platform.ID })
			}
			if hostSelector != "" {
				host, resolveErr := resolveHost(inventory.Hosts, hostSelector)
				if resolveErr != nil {
					return resolveErr
				}
				instances = filterInstances(instances, func(instance computeinventory.EnvironmentInstance) bool { return instance.HostID == host.ID })
			}
			if definitionSelector != "" {
				definition, resolveErr := resolveDefinition(inventory.EnvironmentCatalog, definitionSelector)
				if resolveErr != nil {
					return resolveErr
				}
				instances = filterInstances(instances, func(instance computeinventory.EnvironmentInstance) bool {
					return instance.EnvironmentDefinitionID == definition.ID
				})
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), instanceListResult(inventory, instances))
			}
			return writeInstances(command.OutOrStdout(), instances)
		},
	}
	options.addFlags(command, false)
	command.Flags().StringVar(&platformSelector, "platform", "", "exact platform selector")
	command.Flags().StringVar(&hostSelector, "host", "", "exact host selector")
	command.Flags().StringVar(&definitionSelector, "environment", "", "exact Environment definition selector")
	return command
}

func newEnvironmentInstanceShowCommand(dependencies computeInventoryCommandDependencies) *cobra.Command {
	options := inventoryFormatOptions{format: "text"}
	command := &cobra.Command{
		Use: "show <instance-ref>", Short: "Show one concrete Environment Instance", Args: cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies)
			if err != nil {
				return err
			}
			instance, err := resolveEnvironmentInstance(inventory.EnvironmentInstances, args[0])
			if err != nil {
				return err
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), instanceShowResult(inventory, instance))
			}
			return writeInstances(command.OutOrStdout(), []computeinventory.EnvironmentInstance{instance})
		},
	}
	options.addFlags(command, false)
	return command
}

func loadComputeInventory(ctx context.Context, dependencies computeInventoryCommandDependencies) (computeinventory.Inventory, error) {
	if dependencies.Load == nil {
		return computeinventory.Inventory{}, errors.New("compute inventory dependency is missing")
	}
	client, err := dependencies.Load(ctx)
	if err != nil {
		return computeinventory.Inventory{}, err
	}
	return client.List(ctx)
}

func (options *inventoryFormatOptions) addFlags(command *cobra.Command, includeJSON bool) {
	command.Flags().StringVar(&options.format, "format", "text", "output format: text or json")
	if includeJSON {
		command.Flags().BoolVar(&options.json, "json", false, "print machine-readable JSON")
	}
}

func (options inventoryFormatOptions) resolve() (string, error) {
	if options.format != "text" && options.format != "json" {
		return "", errors.New("--format must be text or json")
	}
	if options.json {
		return "json", nil
	}
	return options.format, nil
}
