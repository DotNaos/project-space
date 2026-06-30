package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

type TemplateValues map[string]any

func readTemplateValues(projectRoot string) (TemplateValues, error) {
	valuesPath := filepath.Join(projectRoot, ".project", "template.values.yaml")
	body, err := os.ReadFile(valuesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return TemplateValues{}, nil
		}
		return nil, err
	}
	var values TemplateValues
	if err := unmarshalYAML(body, &values); err != nil {
		return nil, err
	}
	return values, nil
}

func writeTemplateValues(projectRoot string, values TemplateValues) (string, error) {
	valuesPath := filepath.Join(projectRoot, ".project", "template.values.yaml")
	if err := os.MkdirAll(filepath.Dir(valuesPath), 0o755); err != nil {
		return "", err
	}
	body, err := marshalYAML(values)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(valuesPath, body, 0o644); err != nil {
		return "", err
	}
	return valuesPath, nil
}

func ensureTemplateValues(projectRoot string, template TemplateSpec, modules []string) (string, error) {
	current, err := readTemplateValues(projectRoot)
	if err != nil {
		return "", err
	}
	next, err := mergeTemplateValuesForModules(projectRoot, template, modules, current)
	if err != nil {
		return "", err
	}
	return writeTemplateValues(projectRoot, next)
}

func mergeTemplateValuesForModules(projectRoot string, template TemplateSpec, modules []string, current TemplateValues) (TemplateValues, error) {
	defaults, err := defaultTemplateValuesForProject(projectRoot, template, modules)
	if err != nil {
		return nil, err
	}
	merged := cloneTemplateValues(current)
	specs, err := valueSpecsForModules(template.Modules, modules)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(specs))
	for key := range specs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, ok := lookupTemplateValue(merged, key); ok {
			continue
		}
		if value, ok := lookupTemplateValue(defaults, key); ok {
			setTemplateValue(merged, key, value)
			continue
		}
		if specs[key].Required {
			return nil, fmt.Errorf("template value %s is required but has no current value or default", key)
		}
	}
	return merged, nil
}

func cloneTemplateValues(values TemplateValues) TemplateValues {
	cloned := TemplateValues{}
	for key, value := range values {
		cloned[key] = cloneTemplateValue(value)
	}
	return cloned
}

func cloneTemplateValue(value any) any {
	switch typed := value.(type) {
	case TemplateValues:
		return cloneTemplateValues(typed)
	case map[string]any:
		nested := map[string]any{}
		for key, value := range typed {
			nested[key] = cloneTemplateValue(value)
		}
		return nested
	default:
		return typed
	}
}

func defaultTemplateValuesForProject(projectRoot string, template TemplateSpec, modules []string) (TemplateValues, error) {
	slug := slugify(filepath.Base(projectRoot))
	if slug == "" {
		slug = "example-project"
	}
	displayName := displayNameFromSlug(slug)
	context := map[string]string{
		"project.slug":        slug,
		"project.name":        displayName,
		"project.displayName": displayName,
		"project.packageName": slug,
		"project.goModule":    "github.com/DotNaos/" + slug,
		"project.appScheme":   slug,
		"project.dockerImage": slug,
	}
	specs, err := valueSpecsForModules(template.Modules, modules)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(specs))
	for key := range specs {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	values := TemplateValues{}
	for _, key := range keys {
		spec := specs[key]
		value, ok, err := defaultValueForSpec(key, spec, values, context)
		if err != nil {
			return nil, err
		}
		if !ok {
			if spec.Required {
				return nil, fmt.Errorf("template value %s is required but has no default", key)
			}
			continue
		}
		setTemplateValue(values, key, value)
	}
	return values, nil
}

func valueSpecsForModules(modules map[string]TemplateModuleSpec, moduleNames []string) (map[string]TemplateValueSpec, error) {
	specs := map[string]TemplateValueSpec{}
	for _, moduleName := range moduleNames {
		module, ok := modules[moduleName]
		if !ok {
			return nil, fmt.Errorf("unknown module %q", moduleName)
		}
		for key, spec := range module.Values {
			if existing, ok := specs[key]; ok && !reflect.DeepEqual(existing, spec) {
				return nil, fmt.Errorf("template value %s has conflicting definitions", key)
			}
			specs[key] = spec
		}
	}
	return specs, nil
}

func defaultValueForSpec(key string, spec TemplateValueSpec, values TemplateValues, context map[string]string) (string, bool, error) {
	if spec.DefaultFrom != "" {
		if value, ok := lookupTemplateValue(values, spec.DefaultFrom); ok {
			return value, true, nil
		}
		if value, ok := context[spec.DefaultFrom]; ok {
			return value, true, nil
		}
		return "", false, nil
	}
	if spec.Default != "" {
		rendered, err := renderTemplateValues([]byte(spec.Default), mergeContextValues(values, context))
		if err != nil {
			return "", false, err
		}
		return string(rendered), true, nil
	}
	if value, ok := context[key]; ok {
		return value, true, nil
	}
	return "", false, nil
}

func mergeContextValues(values TemplateValues, context map[string]string) TemplateValues {
	merged := TemplateValues{}
	for key, value := range values {
		merged[key] = value
	}
	keys := make([]string, 0, len(context))
	for key := range context {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, ok := lookupTemplateValue(merged, key); ok {
			continue
		}
		setTemplateValue(merged, key, context[key])
	}
	return merged
}

func setTemplateValue(values TemplateValues, name string, value string) {
	parts := strings.Split(name, ".")
	var current map[string]any = values
	for index, part := range parts {
		if index == len(parts)-1 {
			current[part] = value
			return
		}
		next, ok := stringMap(current[part])
		if !ok {
			next = map[string]any{}
		}
		current[part] = next
		current = next
	}
}

func renderTemplateValues(body []byte, values TemplateValues) ([]byte, error) {
	source := string(body)
	rendered := strings.Builder{}
	cursor := 0
	matches := placeholderRE.FindAllStringSubmatchIndex(source, -1)
	for _, match := range matches {
		if match[0] > 0 && source[match[0]-1] == '$' {
			continue
		}
		rendered.WriteString(source[cursor:match[0]])
		name := strings.TrimSpace(source[match[2]:match[3]])
		value, ok := lookupTemplateValue(values, name)
		if !ok {
			rendered.WriteString("\x00missing:" + name + "\x00")
		} else {
			rendered.WriteString(value)
		}
		cursor = match[1]
	}
	rendered.WriteString(source[cursor:])
	output := rendered.String()
	if start := strings.Index(output, "\x00missing:"); start >= 0 {
		rest := output[start+len("\x00missing:"):]
		end := strings.Index(rest, "\x00")
		if end >= 0 {
			return nil, fmt.Errorf("missing template value %q", rest[:end])
		}
	}
	return []byte(output), nil
}

func lookupTemplateValue(values TemplateValues, name string) (string, bool) {
	parts := strings.Split(name, ".")
	var current any = map[string]any(values)
	for _, part := range parts {
		object, ok := stringMap(current)
		if !ok {
			return "", false
		}
		current, ok = object[part]
		if !ok {
			return "", false
		}
	}
	switch value := current.(type) {
	case string:
		return value, true
	case int, int64, float64, bool:
		return fmt.Sprint(value), true
	default:
		return "", false
	}
}

func stringMap(value any) (map[string]any, bool) {
	switch object := value.(type) {
	case map[string]any:
		return object, true
	case TemplateValues:
		return map[string]any(object), true
	case map[any]any:
		converted := map[string]any{}
		for key, nested := range object {
			keyString, ok := key.(string)
			if !ok {
				return nil, false
			}
			converted[keyString] = nested
		}
		return converted, true
	default:
		return nil, false
	}
}
