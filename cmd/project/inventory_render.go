package main

import (
	"encoding/json"
	"fmt"
	"io"
	"text/tabwriter"

	"github.com/DotNaos/project-space/internal/computeinventory"
)

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func writeInventorySummary(output io.Writer, inventory computeinventory.Inventory) error {
	_, err := fmt.Fprintf(output, "Compute inventory %s at %s\nPlatforms: %d  Hosts: %d  Environment definitions: %d  Instances: %d\n",
		inventory.InventoryState, inventory.CheckedAt, len(inventory.Platforms), len(inventory.Hosts),
		len(inventory.EnvironmentCatalog), len(inventory.EnvironmentInstances))
	return err
}

func writePlatforms(output io.Writer, platforms []computeinventory.Platform) error {
	w := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	defer w.Flush()
	if _, err := fmt.Fprintln(w, "ALIAS\tNAME\tKIND\tID"); err != nil {
		return err
	}
	for _, platform := range platforms {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", platform.Alias, platform.Name, platform.Kind, platform.ID); err != nil {
			return err
		}
	}
	return nil
}

func writeHosts(output io.Writer, hosts []computeinventory.Host) error {
	w := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	defer w.Flush()
	if _, err := fmt.Fprintln(w, "ALIAS\tNAME\tPLATFORM\tCAPABILITIES\tID"); err != nil {
		return err
	}
	for _, host := range hosts {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", host.Alias, host.Name, host.PlatformID, host.Capabilities.State, host.ID); err != nil {
			return err
		}
	}
	return nil
}

func writeDefinitions(output io.Writer, definitions []computeinventory.EnvironmentDefinition) error {
	w := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	defer w.Flush()
	if _, err := fmt.Fprintln(w, "SLUG\tNAME\tOS\tBOOTSTRAP\tID"); err != nil {
		return err
	}
	for _, definition := range definitions {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", definition.Slug, definition.Name, definition.OperatingSystemFamily, definition.BootstrapStrategy, definition.ID); err != nil {
			return err
		}
	}
	return nil
}

func writeInstances(output io.Writer, instances []computeinventory.EnvironmentInstance) error {
	w := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	defer w.Flush()
	if _, err := fmt.Fprintln(w, "ALIAS\tREFERENCE\tHOST\tACCESS\tID"); err != nil {
		return err
	}
	for _, instance := range instances {
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", instance.Alias, instance.Reference, valueOr(instance.HostID, "provider"), accessLabel(instance.AccessRoutes), instance.ID); err != nil {
			return err
		}
	}
	return nil
}

func accessLabel(routes []computeinventory.AccessRoute) string {
	for _, route := range routes {
		if route.Available {
			return "available"
		}
	}
	if len(routes) > 0 {
		return "unavailable"
	}
	return "unknown"
}

func valueOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func writeMachineDeprecation(output io.Writer) {
	_, _ = fmt.Fprintln(output, "DEPRECATED: use `project host` for inventory discovery; `project machine` remains a temporary compatibility path.")
}

type inventoryEnvelope struct {
	CheckedAt      string                       `json:"checkedAt"`
	InventoryState string                       `json:"inventoryState"`
	SchemaVersion  int                          `json:"schemaVersion"`
	Violations     []computeinventory.Violation `json:"violations"`
}
type platformListEnvelope struct {
	inventoryEnvelope
	Platforms []computeinventory.Platform `json:"platforms"`
}
type platformShowEnvelope struct {
	inventoryEnvelope
	Platform computeinventory.Platform `json:"platform"`
}
type hostListEnvelope struct {
	inventoryEnvelope
	Hosts []computeinventory.Host `json:"hosts"`
}
type hostShowEnvelope struct {
	inventoryEnvelope
	Host computeinventory.Host `json:"host"`
}
type definitionListEnvelope struct {
	inventoryEnvelope
	EnvironmentCatalog []computeinventory.EnvironmentDefinition `json:"environmentCatalog"`
}
type definitionShowEnvelope struct {
	inventoryEnvelope
	Environment computeinventory.EnvironmentDefinition `json:"environment"`
}
type instanceListEnvelope struct {
	inventoryEnvelope
	EnvironmentInstances []computeinventory.EnvironmentInstance `json:"environmentInstances"`
}
type instanceShowEnvelope struct {
	inventoryEnvelope
	EnvironmentInstance computeinventory.EnvironmentInstance `json:"environmentInstance"`
}

func envelope(i computeinventory.Inventory) inventoryEnvelope {
	return inventoryEnvelope{i.CheckedAt, i.InventoryState, i.SchemaVersion, i.Violations}
}
func platformListResult(i computeinventory.Inventory, v []computeinventory.Platform) platformListEnvelope {
	return platformListEnvelope{envelope(i), v}
}
func platformShowResult(i computeinventory.Inventory, v computeinventory.Platform) platformShowEnvelope {
	return platformShowEnvelope{envelope(i), v}
}
func hostListResult(i computeinventory.Inventory, v []computeinventory.Host) hostListEnvelope {
	return hostListEnvelope{envelope(i), v}
}
func hostShowResult(i computeinventory.Inventory, v computeinventory.Host) hostShowEnvelope {
	return hostShowEnvelope{envelope(i), v}
}
func definitionListResult(i computeinventory.Inventory, v []computeinventory.EnvironmentDefinition) definitionListEnvelope {
	return definitionListEnvelope{envelope(i), v}
}
func definitionShowResult(i computeinventory.Inventory, v computeinventory.EnvironmentDefinition) definitionShowEnvelope {
	return definitionShowEnvelope{envelope(i), v}
}
func instanceListResult(i computeinventory.Inventory, v []computeinventory.EnvironmentInstance) instanceListEnvelope {
	return instanceListEnvelope{envelope(i), v}
}
func instanceShowResult(i computeinventory.Inventory, v computeinventory.EnvironmentInstance) instanceShowEnvelope {
	return instanceShowEnvelope{envelope(i), v}
}
