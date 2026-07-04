// Package placeholder parses Project template placeholders once and can then
// render them or compile the same template body into a validation regex.
//
// Placeholders use the tiny syntax {{ ns.key }}. Names may contain letters,
// numbers, underscores, dashes, and dots, and must contain a namespace prefix.
// A dollar sign immediately before "{{" escapes the placeholder, preserving the
// literal text. This keeps GitHub Actions expressions such as ${{ github.ref }}
// from being treated as Project template values.
package placeholder

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var (
	placeholderRE           = regexp.MustCompile(`{{\s*([a-zA-Z0-9_.-]+)\s*}}`)
	namespacedPlaceholderRE = regexp.MustCompile(`^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$`)
)

// Values stores resolved template values. Nested map values are resolved using
// dotted placeholder names, for example "project.slug".
type Values map[string]any

// MissingValueError reports the first placeholder name that could not be
// resolved during rendering.
type MissingValueError struct {
	Name string
}

func (err MissingValueError) Error() string {
	return fmt.Sprintf("missing template value %q", err.Name)
}

type segment struct {
	literal     string
	placeholder string
}

// Template is a parsed template body.
type Template struct {
	segments []segment
	names    []string
}

// Parse splits a template body into literal and placeholder segments.
func Parse(body []byte) (Template, error) {
	source := string(body)
	segments := []segment{}
	names := []string{}
	cursor := 0
	for _, match := range placeholderRE.FindAllStringSubmatchIndex(source, -1) {
		if match[0] > 0 && source[match[0]-1] == '$' {
			continue
		}
		name := strings.TrimSpace(source[match[2]:match[3]])
		if !namespacedPlaceholderRE.MatchString(name) {
			return Template{}, fmt.Errorf("invalid placeholder %q; placeholders must be namespaced", name)
		}
		if cursor < match[0] {
			segments = append(segments, segment{literal: source[cursor:match[0]]})
		}
		segments = append(segments, segment{placeholder: name})
		names = append(names, name)
		cursor = match[1]
	}
	if cursor < len(source) {
		segments = append(segments, segment{literal: source[cursor:]})
	}
	return Template{segments: segments, names: names}, nil
}

// Render substitutes placeholders with values.
func (template Template) Render(values Values) ([]byte, error) {
	rendered := strings.Builder{}
	for _, segment := range template.segments {
		if segment.placeholder == "" {
			rendered.WriteString(segment.literal)
			continue
		}
		value, ok := lookupValue(values, segment.placeholder)
		if !ok {
			return nil, MissingValueError{Name: segment.placeholder}
		}
		rendered.WriteString(value)
	}
	return []byte(rendered.String()), nil
}

// ToRegex compiles a template body into a full-string regex where placeholders
// are replaced by their configured slot patterns. It returns placeholder names
// in encounter order.
func (template Template) ToRegex(slotPatterns map[string]string) (*regexp.Regexp, []string, error) {
	source := strings.Builder{}
	for _, segment := range template.segments {
		if segment.placeholder == "" {
			source.WriteString(regexp.QuoteMeta(segment.literal))
			continue
		}
		slotPattern, ok := slotPatterns[segment.placeholder]
		if !ok {
			return nil, nil, fmt.Errorf("missing slot regex for placeholder %q", segment.placeholder)
		}
		source.WriteString("(?:" + slotPattern + ")")
	}
	regex, err := regexp.Compile("(?s)^(?:" + source.String() + ")$")
	if err != nil {
		return nil, nil, err
	}
	return regex, template.Placeholders(), nil
}

// Placeholders returns placeholder names in encounter order.
func (template Template) Placeholders() []string {
	return append([]string(nil), template.names...)
}

// Unrender replaces known concrete values with their placeholder names. Longer
// values are replaced first so specific values win over shorter prefixes.
func Unrender(body []byte, values map[string]string) []byte {
	replacements := unrenderReplacements(values)
	output := string(body)
	for _, replacement := range replacements {
		output = strings.ReplaceAll(output, replacement.value, "{{ "+replacement.name+" }}")
	}
	return []byte(output)
}

type unrenderReplacement struct {
	name  string
	value string
}

func unrenderReplacements(values map[string]string) []unrenderReplacement {
	replacements := []unrenderReplacement{}
	for name, value := range values {
		if len(value) < 3 {
			continue
		}
		replacements = append(replacements, unrenderReplacement{name: name, value: value})
	}
	sort.Slice(replacements, func(i, j int) bool {
		if len(replacements[i].value) != len(replacements[j].value) {
			return len(replacements[i].value) > len(replacements[j].value)
		}
		return replacements[i].name < replacements[j].name
	})
	return replacements
}

func lookupValue(values Values, name string) (string, bool) {
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
	case Values:
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
