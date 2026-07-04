package projectvalidator

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

func fileRulesForPath(template TemplateSpec, path string) (TemplateFileRules, bool) {
	if moduleName := moduleForPath(template, path); moduleName != "" {
		if rules, ok := template.Modules[moduleName].Rules[path]; ok {
			return rules, true
		}
	}
	moduleNames := make([]string, 0, len(template.Modules))
	for moduleName := range template.Modules {
		moduleNames = append(moduleNames, moduleName)
	}
	sort.Strings(moduleNames)
	for _, moduleName := range moduleNames {
		if rules, ok := template.Modules[moduleName].Rules[path]; ok {
			return rules, true
		}
	}
	return TemplateFileRules{}, false
}

func validateStructuredFile(filePath string, actualBody []byte, renderedBody []byte, rules TemplateFileRules) []FileDiagnostic {
	if rules.Format != "json" {
		return []FileDiagnostic{{Path: filePath, Status: StatusViolation, Note: fmt.Sprintf("unsupported structured rule format %q", rules.Format)}}
	}
	var actual any
	if err := json.Unmarshal(actualBody, &actual); err != nil {
		return []FileDiagnostic{{Path: filePath, Status: StatusViolation, Note: err.Error()}}
	}
	var rendered any
	if err := json.Unmarshal(renderedBody, &rendered); err != nil {
		return []FileDiagnostic{{Path: filePath, Status: StatusViolation, Note: err.Error()}}
	}

	diagnostics := []FileDiagnostic{}
	for _, entry := range rules.Entries {
		diagnostics = append(diagnostics, validateStructuredRuleEntry(actual, rendered, entry)...)
	}
	sort.SliceStable(diagnostics, func(i, j int) bool { return diagnostics[i].Path < diagnostics[j].Path })
	return diagnostics
}

func validateStructuredRuleEntry(actual any, rendered any, entry TemplateFileRuleEntry) []FileDiagnostic {
	if strings.HasSuffix(entry.Path, "/*") {
		return validateWildcardRuleEntry(actual, rendered, entry)
	}
	actualValue, actualOK := jsonPointerValue(actual, entry.Path)
	renderedValue, renderedOK := jsonPointerValue(rendered, entry.Path)
	return []FileDiagnostic{validateStructuredValue(entry.Path, actualValue, actualOK, renderedValue, renderedOK, entry)}
}

func validateWildcardRuleEntry(actual any, rendered any, entry TemplateFileRuleEntry) []FileDiagnostic {
	parentPath := strings.TrimSuffix(entry.Path, "/*")
	actualParent, ok := jsonPointerValue(actual, parentPath)
	if !ok {
		return nil
	}
	actualObject, ok := actualParent.(map[string]any)
	if !ok {
		return []FileDiagnostic{{Path: parentPath, Status: StatusViolation, Note: "expected object"}}
	}
	renderedParent, _ := jsonPointerValue(rendered, parentPath)
	renderedObject, _ := renderedParent.(map[string]any)

	keys := make([]string, 0, len(actualObject))
	for key := range actualObject {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	diagnostics := []FileDiagnostic{}
	for _, key := range keys {
		childPath := parentPath + "/" + key
		renderedValue, renderedOK := renderedObject[key]
		diagnostics = append(diagnostics, validateStructuredValue(childPath, actualObject[key], true, renderedValue, renderedOK, entry))
	}
	return diagnostics
}

func validateStructuredValue(path string, actual any, actualOK bool, rendered any, renderedOK bool, entry TemplateFileRuleEntry) FileDiagnostic {
	switch entry.Kind {
	case "frozen":
		if actualOK && renderedOK && reflect.DeepEqual(actual, rendered) {
			return FileDiagnostic{Path: path, Status: StatusOK, Note: "frozen"}
		}
		return FileDiagnostic{Path: path, Status: StatusViolation, Note: fmt.Sprintf("expected frozen value: %s", jsonRuleValue(rendered))}
	case "slot":
		value, ok := actual.(string)
		if !actualOK || !ok {
			return FileDiagnostic{Path: path, Status: StatusViolation, Note: "invalid slot"}
		}
		pattern := entry.Pattern
		if pattern == "" {
			pattern = ".*"
		}
		regex, err := regexp.Compile(pattern)
		if err != nil {
			return FileDiagnostic{Path: path, Status: StatusViolation, Note: err.Error()}
		}
		if regex.MatchString(value) {
			return FileDiagnostic{Path: path, Status: StatusOK, Note: "slot"}
		}
		return FileDiagnostic{Path: path, Status: StatusViolation, Note: "invalid slot"}
	case "open":
		return FileDiagnostic{Path: path, Status: StatusOK, Note: "open"}
	case "deny":
		if !actualOK {
			return FileDiagnostic{Path: path, Status: StatusOK, Note: "deny"}
		}
		return FileDiagnostic{Path: path, Status: StatusViolation, Note: "not allowed by template"}
	default:
		return FileDiagnostic{Path: path, Status: StatusViolation, Note: fmt.Sprintf("unknown rule kind %q", entry.Kind)}
	}
}

func jsonPointerValue(value any, pointer string) (any, bool) {
	if pointer == "" || pointer == "/" {
		return value, true
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, false
	}
	current := value
	for _, rawPart := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		part := strings.ReplaceAll(strings.ReplaceAll(rawPart, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func jsonRuleValue(value any) string {
	body, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(body)
}
