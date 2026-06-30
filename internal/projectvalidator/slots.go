package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

type SlotRule struct {
	Name    string
	BaseDir string
	rules   []*regexp.Regexp
}

type slotFile struct {
	Name     string            `yaml:"name"`
	Allow    []string          `yaml:"allow"`
	Patterns map[string]string `yaml:"patterns"`
}

func readSlotRules(templateRoot string) ([]SlotRule, error) {
	slots := []SlotRule{}
	if err := filepath.WalkDir(templateRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if shouldSkipTemplateWorkDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() != ".slot.yaml" {
			return nil
		}
		slot, err := readSlotFile(templateRoot, path)
		if err != nil {
			return err
		}
		slots = append(slots, slot)
		return nil
	}); err != nil {
		return nil, err
	}
	return slots, nil
}

func readSlotFile(templateRoot string, slotPath string) (SlotRule, error) {
	body, err := os.ReadFile(slotPath)
	if err != nil {
		return SlotRule{}, err
	}
	var spec slotFile
	if err := unmarshalYAML(body, &spec); err != nil {
		return SlotRule{}, err
	}
	if spec.Name == "" {
		return SlotRule{}, fmt.Errorf("%s is missing name", slotPath)
	}
	if len(spec.Allow) == 0 {
		return SlotRule{}, fmt.Errorf("%s is missing allow patterns", slotPath)
	}
	baseDir, err := filepath.Rel(templateRoot, filepath.Dir(slotPath))
	if err != nil {
		return SlotRule{}, err
	}
	baseDir = normalizePath(baseDir)
	if baseDir == "." {
		baseDir = ""
	}
	rule := SlotRule{Name: spec.Name, BaseDir: baseDir}
	for _, allow := range spec.Allow {
		regex, err := compilePathPattern(allow, spec.Patterns)
		if err != nil {
			return SlotRule{}, fmt.Errorf("%s: %w", slotPath, err)
		}
		rule.rules = append(rule.rules, regex)
	}
	return rule, nil
}

func (slot SlotRule) Match(path string) bool {
	relative := normalizePath(path)
	if slot.BaseDir != "" {
		prefix := slot.BaseDir + "/"
		if relative == slot.BaseDir {
			return false
		}
		if len(relative) <= len(prefix) || relative[:len(prefix)] != prefix {
			return false
		}
		relative = relative[len(prefix):]
	}
	for _, rule := range slot.rules {
		if rule.MatchString(relative) {
			return true
		}
	}
	return false
}
