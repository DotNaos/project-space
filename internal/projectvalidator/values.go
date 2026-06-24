package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
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

func renderTemplateValues(body []byte, values TemplateValues) ([]byte, error) {
	rendered := placeholderRE.ReplaceAllStringFunc(string(body), func(match string) string {
		name := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(match, "{{"), "}}"))
		value, ok := lookupTemplateValue(values, name)
		if !ok {
			return "\x00missing:" + name + "\x00"
		}
		return value
	})
	if start := strings.Index(rendered, "\x00missing:"); start >= 0 {
		rest := rendered[start+len("\x00missing:"):]
		end := strings.Index(rest, "\x00")
		if end >= 0 {
			return nil, fmt.Errorf("missing template value %q", rest[:end])
		}
	}
	return []byte(rendered), nil
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
