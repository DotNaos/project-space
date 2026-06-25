package projectvalidator

import (
	"fmt"
	"regexp"
	"strings"
)

func compilePathPattern(pattern string, variables map[string]string) (*regexp.Regexp, error) {
	if pattern == "" {
		return nil, fmt.Errorf("empty path pattern")
	}
	normalized := normalizePath(pattern)
	if strings.HasPrefix(normalized, "/") {
		return nil, fmt.Errorf("absolute path pattern %q is not allowed", pattern)
	}
	for _, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return nil, fmt.Errorf("path pattern %q may not contain ..", pattern)
		}
	}

	source := ""
	for index := 0; index < len(normalized); {
		switch {
		case strings.HasPrefix(normalized[index:], "**/*"):
			source += "(?:.*/)?[^/]*"
			index += len("**/*")
		case strings.HasPrefix(normalized[index:], "**"):
			source += ".*"
			index += len("**")
		case normalized[index] == '*':
			source += "[^/]*"
			index++
		case normalized[index] == '{':
			end := strings.IndexByte(normalized[index:], '}')
			if end < 0 {
				return nil, fmt.Errorf("unclosed variable in path pattern %q", pattern)
			}
			name := normalized[index+1 : index+end]
			if name == "" {
				return nil, fmt.Errorf("empty variable in path pattern %q", pattern)
			}
			variablePattern := "[^/]+"
			if variables != nil && variables[name] != "" {
				variablePattern = variables[name]
			}
			source += "(?:" + variablePattern + ")"
			index += end + 1
		default:
			source += regexp.QuoteMeta(string(normalized[index]))
			index++
		}
	}
	return regexp.Compile("^(?:" + source + ")$")
}
