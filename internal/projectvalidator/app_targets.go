package projectvalidator

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var appTargetIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

var supportedAppDevices = map[string]bool{
	"desktop": true,
	"tablet":  true,
	"mobile":  true,
}

func resolveAppTargetSelections(template TemplateSpec, selections []AppTargetSelection, require bool) ([]string, TemplateValues, error) {
	targets := templateAppTargets(template)
	if len(targets) == 0 {
		if len(selections) > 0 {
			return nil, nil, fmt.Errorf("template %s does not declare selectable app targets", template.Name)
		}
		return nil, TemplateValues{}, nil
	}
	if require && len(selections) == 0 {
		return nil, nil, fmt.Errorf("template %s requires at least one --target <target>:<device>[,<device>...] selection", template.Name)
	}

	values := TemplateValues{}
	targetIDs := make([]string, 0, len(targets))
	for targetID := range targets {
		targetIDs = append(targetIDs, targetID)
	}
	sort.Strings(targetIDs)
	for _, targetID := range targetIDs {
		target := targets[targetID]
		setTemplateBool(values, "app.targets."+targetID, false)
		setTemplateBool(values, "app.implementations."+targetID+".shared", false)
		devices := make([]string, 0, len(target.devices))
		for device := range target.devices {
			devices = append(devices, device)
		}
		sort.Strings(devices)
		for _, device := range devices {
			setTemplateBool(values, "app.devices."+targetID+"."+device, false)
			setTemplateBool(values, "app.implementations."+targetID+"."+device, false)
		}
	}

	selectedModules := []string{}
	seenTargets := map[string]bool{}
	for _, selection := range selections {
		targetID := strings.TrimSpace(selection.Target)
		target, ok := targets[targetID]
		if !ok {
			return nil, nil, fmt.Errorf("unknown app target %q", targetID)
		}
		if seenTargets[targetID] {
			return nil, nil, fmt.Errorf("app target %q was selected more than once", targetID)
		}
		seenTargets[targetID] = true
		if len(selection.Devices) == 0 {
			return nil, nil, fmt.Errorf("app target %q requires at least one device", targetID)
		}
		seenDevices := map[string]bool{}
		for _, rawDevice := range selection.Devices {
			device := strings.TrimSpace(rawDevice)
			if !target.devices[device] {
				return nil, nil, fmt.Errorf("app target %q does not support device %q", targetID, device)
			}
			if seenDevices[device] {
				return nil, nil, fmt.Errorf("device %q was selected more than once for app target %q", device, targetID)
			}
			seenDevices[device] = true
			setTemplateBool(values, "app.devices."+targetID+"."+device, true)
		}
		setTemplateBool(values, "app.targets."+targetID, true)
		selectedModules = append(selectedModules, target.module)
		if target.canShare(seenDevices) {
			setTemplateBool(values, "app.implementations."+targetID+".shared", true)
			selectedModules = append(selectedModules, target.sharedModule)
		} else {
			for device := range seenDevices {
				implementationModule := target.deviceModules[device]
				if implementationModule == "" {
					return nil, nil, fmt.Errorf("app target %q does not declare an implementation module for device %q", targetID, device)
				}
				setTemplateBool(values, "app.implementations."+targetID+"."+device, true)
				selectedModules = append(selectedModules, implementationModule)
			}
		}
	}

	defaults, err := defaultModuleClosure(template.Modules)
	if err != nil {
		return nil, nil, err
	}
	selectedModules = append(selectedModules, defaults...)
	for _, module := range append([]string{}, selectedModules...) {
		closure, err := moduleInstallClosure(template.Modules, module)
		if err != nil {
			return nil, nil, err
		}
		selectedModules = append(selectedModules, closure...)
	}
	return uniqueSortedModules(selectedModules), values, nil
}

type appTargetModule struct {
	module        string
	devices       map[string]bool
	sharedModule  string
	sharedDevices map[string]bool
	deviceModules map[string]string
}

func (target appTargetModule) canShare(selected map[string]bool) bool {
	if target.sharedModule == "" || len(selected) < 2 {
		return false
	}
	for device := range selected {
		if !target.sharedDevices[device] {
			return false
		}
	}
	return true
}

func templateAppTargets(template TemplateSpec) map[string]appTargetModule {
	result := map[string]appTargetModule{}
	names := make([]string, 0, len(template.Modules))
	for name := range template.Modules {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		spec := template.Modules[name].AppTarget
		if spec == nil {
			continue
		}
		devices := map[string]bool{}
		for _, device := range spec.Devices {
			devices[device] = true
		}
		sharedDevices := map[string]bool{}
		for _, device := range spec.SharedDevices {
			sharedDevices[device] = true
		}
		result[spec.ID] = appTargetModule{
			module:        name,
			devices:       devices,
			sharedModule:  spec.SharedModule,
			sharedDevices: sharedDevices,
			deviceModules: spec.DeviceModules,
		}
	}
	return result
}

func validateTemplateAppTargets(template TemplateSpec) error {
	seen := map[string]string{}
	moduleNames := make([]string, 0, len(template.Modules))
	for moduleName := range template.Modules {
		moduleNames = append(moduleNames, moduleName)
	}
	sort.Strings(moduleNames)
	for _, moduleName := range moduleNames {
		module := template.Modules[moduleName]
		spec := module.AppTarget
		if spec == nil {
			continue
		}
		if !appTargetIDPattern.MatchString(spec.ID) {
			return fmt.Errorf("module %s appTarget id %q must use lowercase letters, numbers, and dashes", moduleName, spec.ID)
		}
		if module.Default {
			return fmt.Errorf("module %s appTarget %q cannot be a default module", moduleName, spec.ID)
		}
		if previous, ok := seen[spec.ID]; ok {
			return fmt.Errorf("app target %q is declared by both %s and %s", spec.ID, previous, moduleName)
		}
		seen[spec.ID] = moduleName
		if len(spec.Devices) == 0 {
			return fmt.Errorf("module %s appTarget %q requires at least one device", moduleName, spec.ID)
		}
		devices := map[string]bool{}
		for _, device := range spec.Devices {
			if !supportedAppDevices[device] {
				return fmt.Errorf("module %s appTarget %q has unsupported device %q", moduleName, spec.ID, device)
			}
			if devices[device] {
				return fmt.Errorf("module %s appTarget %q repeats device %q", moduleName, spec.ID, device)
			}
			devices[device] = true
		}
		if spec.SharedModule != "" {
			shared, ok := template.Modules[spec.SharedModule]
			if !ok {
				return fmt.Errorf("module %s appTarget %q references unknown sharedModule %q", moduleName, spec.ID, spec.SharedModule)
			}
			if shared.Default {
				return fmt.Errorf("module %s appTarget %q sharedModule %q cannot be a default module", moduleName, spec.ID, spec.SharedModule)
			}
			if len(spec.SharedDevices) < 2 {
				return fmt.Errorf("module %s appTarget %q sharedModule requires at least two sharedDevices", moduleName, spec.ID)
			}
		} else if len(spec.SharedDevices) > 0 {
			return fmt.Errorf("module %s appTarget %q sharedDevices require sharedModule", moduleName, spec.ID)
		}
		sharedDevices := map[string]bool{}
		for _, device := range spec.SharedDevices {
			if !devices[device] {
				return fmt.Errorf("module %s appTarget %q shares unsupported device %q", moduleName, spec.ID, device)
			}
			if sharedDevices[device] {
				return fmt.Errorf("module %s appTarget %q repeats shared device %q", moduleName, spec.ID, device)
			}
			sharedDevices[device] = true
		}
		deviceModuleNames := make([]string, 0, len(spec.DeviceModules))
		for device := range spec.DeviceModules {
			deviceModuleNames = append(deviceModuleNames, device)
		}
		sort.Strings(deviceModuleNames)
		for _, device := range deviceModuleNames {
			implementationModule := spec.DeviceModules[device]
			if !devices[device] {
				return fmt.Errorf("module %s appTarget %q maps unsupported device %q", moduleName, spec.ID, device)
			}
			implementation, ok := template.Modules[implementationModule]
			if !ok {
				return fmt.Errorf("module %s appTarget %q references unknown device module %q", moduleName, spec.ID, implementationModule)
			}
			if implementation.Default {
				return fmt.Errorf("module %s appTarget %q device module %q cannot be a default module", moduleName, spec.ID, implementationModule)
			}
		}
		supportedDevices := make([]string, 0, len(devices))
		for device := range devices {
			supportedDevices = append(supportedDevices, device)
		}
		sort.Strings(supportedDevices)
		for _, device := range supportedDevices {
			if spec.DeviceModules[device] == "" {
				return fmt.Errorf("module %s appTarget %q requires a deviceModule for %q", moduleName, spec.ID, device)
			}
		}
	}
	return nil
}
