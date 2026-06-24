package projectvalidator

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type templateIgnore struct {
	rules []templateIgnoreRule
}

type templateIgnoreRule struct {
	raw      string
	hasSlash bool
	regex    *regexp.Regexp
}

func readTemplateIgnore(templateRoot string) templateIgnore {
	ignore := templateIgnore{}
	body, err := os.ReadFile(filepath.Join(templateRoot, ".templateignore"))
	if err != nil {
		return ignore
	}
	for _, rawLine := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasSuffix(line, "/") {
			line += "**"
		}
		regex, err := compilePathPattern(line, nil)
		if err != nil {
			continue
		}
		ignore.rules = append(ignore.rules, templateIgnoreRule{
			raw:      line,
			hasSlash: strings.Contains(line, "/"),
			regex:    regex,
		})
	}
	return ignore
}

func (ignore templateIgnore) Match(path string) bool {
	normalized := normalizePath(path)
	for _, rule := range ignore.rules {
		if rule.regex.MatchString(normalized) {
			return true
		}
		if !rule.hasSlash && rule.regex.MatchString(filepath.Base(normalized)) {
			return true
		}
	}
	return false
}
