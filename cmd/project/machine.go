package main

import "github.com/spf13/cobra"

func newMachineCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "machine",
		Short: "Inspect and manage Project machines",
	}
	command.AddCommand(newMachineResourcesCommand(machineResourcesCommandDependencies{}))
	return command
}
