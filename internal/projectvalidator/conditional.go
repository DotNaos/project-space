package projectvalidator

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
)

var (
	conditionalStart     = regexp.MustCompile(`^\{\{#if\s+([a-zA-Z0-9_.-]+)\s*\}\}$`)
	conditionalUnless    = regexp.MustCompile(`^\{\{#unless\s+([a-zA-Z0-9_.-]+)\s*\}\}$`)
	conditionalEnd       = regexp.MustCompile(`^\{\{/if\s*\}\}$`)
	conditionalUnlessEnd = regexp.MustCompile(`^\{\{/unless\s*\}\}$`)
)

type conditionalFrame struct {
	path   string
	active bool
}

func renderConditionalTemplateBody(body []byte, values TemplateValues) ([]byte, error) {
	lines := bytes.SplitAfter(body, []byte("\n"))
	stack := []conditionalFrame{}
	output := bytes.Buffer{}
	for index, line := range lines {
		trimmed := strings.TrimSpace(string(line))
		if match := conditionalStart.FindStringSubmatch(trimmed); match != nil {
			active, err := lookupTemplateBool(values, match[1])
			if err != nil {
				return nil, fmt.Errorf("conditional line %d: %w", index+1, err)
			}
			if len(stack) > 0 && !stack[len(stack)-1].active {
				active = false
			}
			stack = append(stack, conditionalFrame{path: match[1], active: active})
			continue
		}
		if match := conditionalUnless.FindStringSubmatch(trimmed); match != nil {
			active, err := lookupTemplateBool(values, match[1])
			if err != nil {
				return nil, fmt.Errorf("conditional line %d: %w", index+1, err)
			}
			if len(stack) > 0 && !stack[len(stack)-1].active {
				active = true
			}
			stack = append(stack, conditionalFrame{path: match[1], active: !active})
			continue
		}
		if strings.HasPrefix(trimmed, "{{#if") {
			return nil, fmt.Errorf("conditional line %d has invalid if syntax", index+1)
		}
		if strings.HasPrefix(trimmed, "{{#unless") {
			return nil, fmt.Errorf("conditional line %d has invalid unless syntax", index+1)
		}
		if conditionalEnd.MatchString(trimmed) {
			if len(stack) == 0 {
				return nil, fmt.Errorf("conditional line %d closes no open if block", index+1)
			}
			stack = stack[:len(stack)-1]
			continue
		}
		if conditionalUnlessEnd.MatchString(trimmed) {
			if len(stack) == 0 {
				return nil, fmt.Errorf("conditional line %d closes no open unless block", index+1)
			}
			stack = stack[:len(stack)-1]
			continue
		}
		if strings.HasPrefix(trimmed, "{{/if") {
			return nil, fmt.Errorf("conditional line %d has invalid closing syntax", index+1)
		}
		if strings.HasPrefix(trimmed, "{{/unless") {
			return nil, fmt.Errorf("conditional line %d has invalid closing unless syntax", index+1)
		}
		if len(stack) == 0 || stack[len(stack)-1].active {
			output.Write(line)
		}
	}
	if len(stack) > 0 {
		return nil, fmt.Errorf("conditional for %s is missing {{/if}}", stack[len(stack)-1].path)
	}
	return output.Bytes(), nil
}

func conditionalTemplatePaths(body []byte) ([]string, error) {
	paths := []string{}
	depth := 0
	for index, line := range bytes.Split(body, []byte("\n")) {
		trimmed := strings.TrimSpace(string(line))
		if match := conditionalStart.FindStringSubmatch(trimmed); match != nil {
			paths = append(paths, match[1])
			depth++
			continue
		}
		if match := conditionalUnless.FindStringSubmatch(trimmed); match != nil {
			paths = append(paths, match[1])
			depth++
			continue
		}
		if strings.HasPrefix(trimmed, "{{#if") {
			return nil, fmt.Errorf("conditional line %d has invalid if syntax", index+1)
		}
		if strings.HasPrefix(trimmed, "{{#unless") {
			return nil, fmt.Errorf("conditional line %d has invalid unless syntax", index+1)
		}
		if conditionalEnd.MatchString(trimmed) {
			if depth == 0 {
				return nil, fmt.Errorf("conditional line %d closes no open if block", index+1)
			}
			depth--
			continue
		}
		if conditionalUnlessEnd.MatchString(trimmed) {
			if depth == 0 {
				return nil, fmt.Errorf("conditional line %d closes no open unless block", index+1)
			}
			depth--
			continue
		}
		if strings.HasPrefix(trimmed, "{{/if") {
			return nil, fmt.Errorf("conditional line %d has invalid closing syntax", index+1)
		}
		if strings.HasPrefix(trimmed, "{{/unless") {
			return nil, fmt.Errorf("conditional line %d has invalid closing unless syntax", index+1)
		}
	}
	if depth != 0 {
		return nil, fmt.Errorf("conditional template has %d unclosed if block(s)", depth)
	}
	return paths, nil
}

func lookupTemplateBool(values TemplateValues, name string) (bool, error) {
	value, ok := lookupTemplateAny(values, name)
	if !ok {
		return false, fmt.Errorf("missing template condition value %q", name)
	}
	boolean, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("template condition value %q must be boolean", name)
	}
	return boolean, nil
}
