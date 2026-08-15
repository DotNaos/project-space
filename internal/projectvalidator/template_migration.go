package projectvalidator

import (
	"fmt"
	"sort"
)

type templateUpdateModules struct {
	current         []string
	next            []string
	selectionValues TemplateValues
}

func resolveTemplateUpdateModules(next TemplateSpec, locked []string, targets []AppTargetSelection) (templateUpdateModules, error) {
	legacy := []string{}
	for _, moduleName := range locked {
		if _, ok := next.Modules[moduleName]; !ok {
			legacy = append(legacy, moduleName)
		}
	}
	if len(legacy) == 0 {
		if len(targets) > 0 {
			return templateUpdateModules{}, fmt.Errorf("--target is only valid when the template update migrates a legacy module")
		}
		return templateUpdateModules{
			current: append([]string{}, locked...),
			next:    append([]string{}, locked...),
		}, nil
	}

	for _, moduleName := range legacy {
		if !hasModuleMigration(next, moduleName) {
			return templateUpdateModules{}, fmt.Errorf("unknown module %q in the target template; no migration is declared", moduleName)
		}
	}

	selectionModules := []string{}
	selectionValues := TemplateValues{}
	if len(templateAppTargets(next)) > 0 {
		if len(targets) == 0 {
			return templateUpdateModules{}, fmt.Errorf("template update requires at least one --target <target>:<device>[,<device>...] when migrating legacy modules")
		}
		var err error
		selectionModules, selectionValues, err = resolveAppTargetSelections(next, targets, true)
		if err != nil {
			return templateUpdateModules{}, err
		}
	}

	nextModules := append([]string{}, selectionModules...)
	for _, legacyName := range legacy {
		for _, replacement := range moduleMigrationTargets(next, legacyName) {
			closure, err := moduleInstallClosure(next.Modules, replacement)
			if err != nil {
				return templateUpdateModules{}, err
			}
			nextModules = append(nextModules, closure...)
		}
	}

	return templateUpdateModules{
		current:         append([]string{}, locked...),
		next:            uniqueSortedModules(nextModules),
		selectionValues: selectionValues,
	}, nil
}

func hasModuleMigration(template TemplateSpec, legacyName string) bool {
	return len(moduleMigrationTargets(template, legacyName)) > 0
}

func moduleMigrationTargets(template TemplateSpec, legacyName string) []string {
	targets := []string{}
	for name, module := range template.Modules {
		for _, migrated := range module.MigratesFrom {
			if migrated == legacyName {
				targets = append(targets, name)
				break
			}
		}
	}
	sort.Strings(targets)
	return targets
}
