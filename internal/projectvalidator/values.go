package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/placeholder"
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
		if value, ok := lookupTemplateAny(defaults, key); ok {
			setTemplateAny(merged, key, cloneTemplateValue(value))
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
	setTemplateValue(values, "project.slug", slug)
	for _, key := range keys {
		_, ok, err := resolveDefaultValue(key, specs, values, map[string]bool{})
		if err != nil {
			return nil, err
		}
		if !ok {
			if specs[key].Required {
				return nil, fmt.Errorf("template value %s is required but has no default", key)
			}
			continue
		}
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

func resolveDefaultValue(key string, specs map[string]TemplateValueSpec, values TemplateValues, visiting map[string]bool) (string, bool, error) {
	if value, ok := lookupTemplateValue(values, key); ok {
		return value, true, nil
	}
	spec, ok := specs[key]
	if !ok {
		return "", false, nil
	}
	if visiting[key] {
		return "", false, fmt.Errorf("template value %s has a defaultFrom cycle", key)
	}
	visiting[key] = true
	defer delete(visiting, key)

	var value string
	var resolved bool
	if spec.Default != "" {
		template, err := placeholder.Parse([]byte(spec.Default))
		if err != nil {
			return "", false, err
		}
		for _, placeholderName := range template.Placeholders() {
			if _, ok := lookupTemplateValue(values, placeholderName); ok {
				continue
			}
			if _, _, err := resolveDefaultValue(placeholderName, specs, values, visiting); err != nil {
				return "", false, err
			}
		}
		rendered, err := template.Render(placeholderValues(values))
		if err != nil {
			return "", false, err
		}
		value = string(rendered)
		resolved = true
	} else if spec.DefaultFrom != "" {
		sourceValue, ok, err := resolveDefaultValue(spec.DefaultFrom, specs, values, visiting)
		if err != nil {
			return "", false, err
		}
		if !ok {
			return "", false, nil
		}
		value = sourceValue
		resolved = true
	}
	if !resolved {
		return "", false, nil
	}
	transformed, err := transformTemplateValue(value, spec.Transform)
	if err != nil {
		return "", false, fmt.Errorf("template value %s: %w", key, err)
	}
	if spec.Type == "boolean" {
		boolean, err := strconv.ParseBool(transformed)
		if err != nil {
			return "", false, fmt.Errorf("template value %s must resolve to a boolean: %w", key, err)
		}
		setTemplateBool(values, key, boolean)
	} else {
		setTemplateValue(values, key, transformed)
	}
	return transformed, true, nil
}

func transformTemplateValue(value string, transform string) (string, error) {
	switch transform {
	case "":
		return value, nil
	case "title":
		return displayNameFromSlug(value), nil
	case "slug":
		return slugify(value), nil
	default:
		return "", fmt.Errorf("unknown transform %q", transform)
	}
}

func setTemplateValue(values TemplateValues, name string, value string) {
	setTemplateAny(values, name, value)
}

func setTemplateBool(values TemplateValues, name string, value bool) {
	setTemplateAny(values, name, value)
}

func setTemplateAny(values TemplateValues, name string, value any) {
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

func renderTemplateBody(body []byte, values TemplateValues) ([]byte, error) {
	conditioned, err := renderConditionalTemplateBody(body, values)
	if err != nil {
		return nil, err
	}
	template, err := placeholder.Parse(conditioned)
	if err != nil {
		return nil, err
	}
	return template.Render(placeholderValues(values))
}

func placeholderValues(values TemplateValues) placeholder.Values {
	converted := placeholder.Values{}
	for key, value := range values {
		converted[key] = placeholderValue(value)
	}
	return converted
}

func placeholderValue(value any) any {
	switch typed := value.(type) {
	case TemplateValues:
		return placeholderValues(typed)
	case map[string]any:
		nested := map[string]any{}
		for key, value := range typed {
			nested[key] = placeholderValue(value)
		}
		return nested
	case map[any]any:
		nested := map[string]any{}
		for key, value := range typed {
			keyString, ok := key.(string)
			if !ok {
				return typed
			}
			nested[keyString] = placeholderValue(value)
		}
		return nested
	default:
		return typed
	}
}

func lookupTemplateValue(values TemplateValues, name string) (string, bool) {
	current, ok := lookupTemplateAny(values, name)
	if !ok {
		return "", false
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

func lookupTemplateAny(values TemplateValues, name string) (any, bool) {
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
	return current, true
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
