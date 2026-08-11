package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/DotNaos/project-space/internal/computeinventory"
)

func resolvePlatform(platforms []computeinventory.Platform, selector string) (computeinventory.Platform, error) {
	for _, platform := range platforms {
		if platform.ID == selector {
			return platform, nil
		}
	}
	matches := make([]computeinventory.Platform, 0)
	for _, platform := range platforms {
		if equalFoldAny(selector, platform.Alias, platform.Name, platform.Kind) {
			matches = append(matches, platform)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return computeinventory.Platform{}, fmt.Errorf("platform %q was not found", selector)
	}
	candidates := make([]string, 0, len(matches))
	for _, match := range matches {
		candidates = append(candidates, fmt.Sprintf("%s (%s)", match.ID, match.Name))
	}
	return computeinventory.Platform{}, ambiguousSelector("platform", selector, candidates)
}

func resolveHost(hosts []computeinventory.Host, selector string) (computeinventory.Host, error) {
	for _, host := range hosts {
		if host.ID == selector {
			return host, nil
		}
	}
	matches := make([]computeinventory.Host, 0)
	for _, host := range hosts {
		if equalFoldAny(selector, host.Alias, host.Name) {
			matches = append(matches, host)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return computeinventory.Host{}, fmt.Errorf("host %q was not found", selector)
	}
	candidates := make([]string, 0, len(matches))
	for _, match := range matches {
		candidates = append(candidates, fmt.Sprintf("%s (%s)", match.ID, match.Name))
	}
	return computeinventory.Host{}, ambiguousSelector("host", selector, candidates)
}

func resolveDefinition(definitions []computeinventory.EnvironmentDefinition, selector string) (computeinventory.EnvironmentDefinition, error) {
	for _, definition := range definitions {
		if definition.ID == selector {
			return definition, nil
		}
	}
	matches := make([]computeinventory.EnvironmentDefinition, 0)
	for _, definition := range definitions {
		if equalFoldAny(selector, definition.Slug, definition.Name) {
			matches = append(matches, definition)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return computeinventory.EnvironmentDefinition{}, fmt.Errorf("Environment definition %q was not found", selector)
	}
	candidates := make([]string, 0, len(matches))
	for _, match := range matches {
		candidates = append(candidates, fmt.Sprintf("%s (%s)", match.ID, match.Name))
	}
	return computeinventory.EnvironmentDefinition{}, ambiguousSelector("Environment definition", selector, candidates)
}

func resolveEnvironmentInstance(instances []computeinventory.EnvironmentInstance, selector string) (computeinventory.EnvironmentInstance, error) {
	for _, instance := range instances {
		if instance.ID == selector {
			return instance, nil
		}
	}
	for _, instance := range instances {
		if instance.Reference == selector {
			return instance, nil
		}
	}
	matches := make([]computeinventory.EnvironmentInstance, 0)
	for _, instance := range instances {
		if equalFoldAny(selector, instance.Alias, instance.Name) {
			matches = append(matches, instance)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return computeinventory.EnvironmentInstance{}, fmt.Errorf("Environment Instance %q was not found", selector)
	}
	candidates := make([]string, 0, len(matches))
	for _, match := range matches {
		candidates = append(candidates, fmt.Sprintf("%s [%s]", match.Reference, match.ID))
	}
	return computeinventory.EnvironmentInstance{}, ambiguousSelector("Environment Instance", selector, candidates)
}

func ambiguousSelector(kind, selector string, candidates []string) error {
	sort.Strings(candidates)
	return fmt.Errorf("%s selector %q is ambiguous; exact candidates: %s", kind, selector, strings.Join(candidates, ", "))
}

func equalFoldAny(selector string, values ...string) bool {
	for _, value := range values {
		if strings.EqualFold(selector, value) {
			return true
		}
	}
	return false
}

func filterHostsByPlatform(hosts []computeinventory.Host, platformID string) []computeinventory.Host {
	filtered := make([]computeinventory.Host, 0)
	for _, host := range hosts {
		if host.PlatformID == platformID {
			filtered = append(filtered, host)
		}
	}
	return filtered
}

func filterInstances(
	instances []computeinventory.EnvironmentInstance,
	keep func(computeinventory.EnvironmentInstance) bool,
) []computeinventory.EnvironmentInstance {
	filtered := make([]computeinventory.EnvironmentInstance, 0)
	for _, instance := range instances {
		if keep(instance) {
			filtered = append(filtered, instance)
		}
	}
	return filtered
}
