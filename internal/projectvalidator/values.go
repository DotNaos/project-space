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
