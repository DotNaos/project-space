package projectvalidator

import (
	"fmt"
	"regexp"
)

var placeholderRE = regexp.MustCompile(`{{\s*([a-zA-Z0-9_.-]+)\s*}}`)
var anyPlaceholderRE = regexp.MustCompile(`{{\s*[a-zA-Z0-9_.-]+\s*}}`)
var namespacedPlaceholderRE = regexp.MustCompile(`^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$`)

type compiledTemplateRegex struct {
	regex        *regexp.Regexp
	placeholders []string
}

func compileTemplateRegex(template string, slotPatterns map[string]string) (compiledTemplateRegex, error) {
	matches := placeholderRE.FindAllStringSubmatchIndex(template, -1)
	source := ""
	cursor := 0
	placeholders := []string{}
	for _, match := range matches {
		source += regexp.QuoteMeta(template[cursor:match[0]])
		name := template[match[2]:match[3]]
		if !namespacedPlaceholderRE.MatchString(name) {
			return compiledTemplateRegex{}, fmt.Errorf("invalid placeholder %q; placeholders must be namespaced", name)
		}
		slotPattern, ok := slotPatterns[name]
		if !ok {
			return compiledTemplateRegex{}, fmt.Errorf("missing slot regex for placeholder %q", name)
		}
		source += "(?:" + slotPattern + ")"
		placeholders = append(placeholders, name)
		cursor = match[1]
	}
	source += regexp.QuoteMeta(template[cursor:])
	regex, err := regexp.Compile("(?s)^(?:" + source + ")$")
	if err != nil {
		return compiledTemplateRegex{}, err
	}
	return compiledTemplateRegex{regex: regex, placeholders: placeholders}, nil
}
