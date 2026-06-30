package projectvalidator

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func PlanTemplateUpdate(projectRoot string, options TemplateUpdateOptions) (TemplateUpdatePlan, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	currentTemplate, err := loadTemplate(root, lock)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	sourceLock := lock
	if options.TemplatePath != "" {
		sourceLock.TemplatePath = options.TemplatePath
	}
	sourceRoot, err := resolveTemplateSourceRoot(root, sourceLock)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	nextTemplate, err := loadTemplateFromRoot(sourceRoot)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	nextChecksum, err := checksumTemplateRoot(sourceRoot)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	currentValues, err := readTemplateValues(root)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	nextValues, err := mergeTemplateValuesForModules(root, nextTemplate, lock.Modules, currentValues)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	valueChanges := planTemplateUpdateValues(currentValues, nextValues)
	fileChanges, err := planTemplateUpdateFiles(root, currentTemplate, nextTemplate, currentValues, nextValues, lock.Modules)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	conflictFolder := ".conflicts/" + updateLabel(lock, nextChecksum)
	return TemplateUpdatePlan{
		ProjectRoot:    root,
		SourceRoot:     sourceRoot,
		FromTemplate:   currentTemplate.Name,
		FromVersion:    lock.Version,
		FromCommit:     lock.Commit,
		FromChecksum:   lock.Checksum,
		ToTemplate:     nextTemplate.Name,
		ToVersion:      nextTemplate.Version,
		ToChecksum:     nextChecksum,
		Values:         valueChanges,
		Files:          fileChanges,
		WouldWrite:     len(valueChanges) > 0 || len(fileChanges) > 0 || lock.Checksum != nextChecksum || lock.Version != nextTemplate.Version,
		ConflictFolder: conflictFolder,
	}, nil
}

func loadTemplateFromRoot(templateRoot string) (TemplateSpec, error) {
	templatePath, err := findTemplateManifest(templateRoot)
	if err != nil {
		return TemplateSpec{}, err
	}
	body, err := os.ReadFile(templatePath)
	if err != nil {
		return TemplateSpec{}, err
	}
	return parseTemplateYAML(templateRoot, templatePath, body)
}

func planNextTemplateValues(projectRoot string, template TemplateSpec, modules []string, current TemplateValues) (TemplateValues, error) {
	specs, err := valueSpecsForModules(template.Modules, modules)
	if err != nil {
		return nil, err
	}
	defaults, err := defaultTemplateValuesForProject(projectRoot, template, modules)
	if err != nil {
		return nil, err
	}
	next := TemplateValues{}
	keys := make([]string, 0, len(specs))
	for key := range specs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if value, ok := lookupTemplateValue(current, key); ok {
			setTemplateValue(next, key, value)
			continue
		}
		if value, ok := lookupTemplateValue(defaults, key); ok {
			setTemplateValue(next, key, value)
			continue
		}
		if specs[key].Required {
			return nil, fmt.Errorf("template value %s is required but has no current value or default", key)
		}
	}
	return next, nil
}

func planTemplateUpdateValues(current TemplateValues, next TemplateValues) []TemplateUpdateValueChange {
	before := flattenTemplateValues(current)
	after := flattenTemplateValues(next)
	paths := map[string]bool{}
	for key := range before {
		paths[key] = true
	}
	for key := range after {
		paths[key] = true
	}
	keys := make([]string, 0, len(paths))
	for key := range paths {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	changes := []TemplateUpdateValueChange{}
	for _, key := range keys {
		beforeValue, hasBefore := before[key]
		afterValue, hasAfter := after[key]
		switch {
		case !hasBefore && hasAfter:
			changes = append(changes, TemplateUpdateValueChange{Action: "ADD", Key: key, After: afterValue})
		case hasBefore && !hasAfter:
			changes = append(changes, TemplateUpdateValueChange{Action: "REMOVE", Key: key, Before: beforeValue})
		case beforeValue != afterValue:
			changes = append(changes, TemplateUpdateValueChange{Action: "CHANGE", Key: key, Before: beforeValue, After: afterValue})
		}
	}
	return changes
}

func flattenTemplateValues(values TemplateValues) map[string]string {
	flat := map[string]string{}
	var walk func(prefix string, value any)
	walk = func(prefix string, value any) {
		switch typed := value.(type) {
		case TemplateValues:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				nextPrefix := key
				if prefix != "" {
					nextPrefix = prefix + "." + key
				}
				walk(nextPrefix, typed[key])
			}
		case map[string]any:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				nextPrefix := key
				if prefix != "" {
					nextPrefix = prefix + "." + key
				}
				walk(nextPrefix, typed[key])
			}
		default:
			flat[prefix] = fmt.Sprint(typed)
		}
	}
	walk("", values)
	delete(flat, "")
	return flat
}

func planTemplateUpdateFiles(projectRoot string, current TemplateSpec, next TemplateSpec, currentValues TemplateValues, nextValues TemplateValues, modules []string) ([]TemplateUpdateFileChange, error) {
	currentFiles, err := templateFilesForModules(current, modules)
	if err != nil {
		return nil, err
	}
	nextFiles, err := templateFilesForModules(next, modules)
	if err != nil {
		return nil, err
	}
	paths := map[string]bool{}
	for path := range currentFiles {
		paths[path] = true
	}
	for path := range nextFiles {
		paths[path] = true
	}
	sortedPaths := make([]string, 0, len(paths))
	for path := range paths {
		sortedPaths = append(sortedPaths, path)
	}
	sort.Strings(sortedPaths)

	changes := []TemplateUpdateFileChange{}
	for _, path := range sortedPaths {
		_, inCurrent := currentFiles[path]
		_, inNext := nextFiles[path]
		module := moduleForPath(next, path)
		if module == "" {
			module = moduleForPath(current, path)
		}
		switch {
		case !inCurrent && inNext:
			result := "clean"
			if fileExists(filepath.Join(projectRoot, filepath.FromSlash(path))) {
				result = "conflict"
			}
			changes = append(changes, TemplateUpdateFileChange{Action: "ADD", Path: path, Result: result, Module: module})
		case inCurrent && !inNext:
			result, err := templateFileUpdateResult(projectRoot, path, current, currentValues, nil)
			if err != nil {
				return nil, err
			}
			changes = append(changes, TemplateUpdateFileChange{Action: "REMOVE", Path: path, Result: result, Module: module})
		default:
			before, err := renderedTemplateFile(current, path, currentValues)
			if err != nil {
				return nil, err
			}
			after, err := renderedTemplateFile(next, path, nextValues)
			if err != nil {
				return nil, err
			}
			if bytes.Equal(before, after) {
				continue
			}
			result, err := templateFileUpdateResult(projectRoot, path, current, currentValues, before)
			if err != nil {
				return nil, err
			}
			changes = append(changes, TemplateUpdateFileChange{Action: "UPDATE", Path: path, Result: result, Module: module})
		}
	}
	return changes, nil
}

func templateFilesForModules(template TemplateSpec, modules []string) (map[string]bool, error) {
	result := map[string]bool{}
	for _, module := range modules {
		files, err := moduleTemplateFiles(template, module)
		if err != nil {
			return nil, err
		}
		for _, path := range files {
			result[path] = true
		}
	}
	return result, nil
}

func renderedTemplateFile(template TemplateSpec, path string, values TemplateValues) ([]byte, error) {
	fileSpec, ok := template.Files[path]
	if !ok {
		return nil, fmt.Errorf("template file %s is not defined", path)
	}
	body, err := os.ReadFile(filepath.Join(template.Root, filepath.FromSlash(fileSpec.TemplatePath)))
	if err != nil {
		return nil, err
	}
	rendered, err := renderTemplateValues(body, values)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return rendered, nil
}

func templateFileUpdateResult(projectRoot string, path string, current TemplateSpec, currentValues TemplateValues, expected []byte) (string, error) {
	projectPath := filepath.Join(projectRoot, filepath.FromSlash(path))
	body, err := os.ReadFile(projectPath)
	if os.IsNotExist(err) {
		return "missing", nil
	}
	if err != nil {
		return "", err
	}
	if expected == nil {
		var renderErr error
		expected, renderErr = renderedTemplateFile(current, path, currentValues)
		if renderErr != nil {
			return "", renderErr
		}
	}
	if bytes.Equal(body, expected) {
		return "clean", nil
	}
	return "conflict", nil
}

func fileExists(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}

func updateLabel(lock TemplateLock, nextChecksum string) string {
	from := shortUpdateID(lock.Commit)
	if from == "" {
		from = shortUpdateID(lock.Checksum)
	}
	if from == "" {
		from = "current"
	}
	to := shortUpdateID(nextChecksum)
	if to == "" {
		to = "next"
	}
	return from + "_to_" + to
}

func shortUpdateID(value string) string {
	value = strings.TrimPrefix(value, "sha256:")
	if value == "" || value == "local" {
		return ""
	}
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}
