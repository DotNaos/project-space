package projectvalidator

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DotNaos/project-space/internal/placeholder"
)

func PlanTemplateUpdate(projectRoot string, options TemplateUpdateOptions) (TemplateUpdatePlan, error) {
	context, err := loadTemplateUpdateContext(projectRoot, options)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	return context.plan, nil
}

type templateUpdateContext struct {
	root            string
	lock            TemplateLock
	currentTemplate TemplateSpec
	nextTemplate    TemplateSpec
	sourceRoot      string
	sourceCommit    string
	nextChecksum    string
	currentValues   TemplateValues
	nextValues      TemplateValues
	currentModules  []string
	nextModules     []string
	plan            TemplateUpdatePlan
}

func loadTemplateUpdateContext(projectRoot string, options TemplateUpdateOptions) (templateUpdateContext, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return templateUpdateContext{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return templateUpdateContext{}, err
	}
	currentTemplate, err := loadTemplate(root, lock)
	if err != nil {
		return templateUpdateContext{}, err
	}
	sourceLock := lock
	if options.TemplatePath != "" {
		sourceLock.TemplatePath = options.TemplatePath
	}
	source, err := resolveTemplateSource(root, sourceLock)
	if err != nil {
		return templateUpdateContext{}, err
	}
	nextTemplate, err := loadTemplateFromRoot(source.Root)
	if err != nil {
		return templateUpdateContext{}, err
	}
	nextChecksum, err := checksumTemplateSourceSnapshot(source.Root)
	if err != nil {
		return templateUpdateContext{}, err
	}
	currentValues, err := readTemplateValues(root)
	if err != nil {
		return templateUpdateContext{}, err
	}
	modules, err := resolveTemplateUpdateModules(nextTemplate, lock.Modules, options.Targets)
	if err != nil {
		return templateUpdateContext{}, err
	}
	seedValues := cloneTemplateValues(currentValues)
	mergeTemplateValueMaps(seedValues, modules.selectionValues)
	nextValues, err := mergeTemplateValuesForModules(root, nextTemplate, modules.next, seedValues)
	if err != nil {
		return templateUpdateContext{}, err
	}
	valueChanges := planTemplateUpdateValues(currentValues, nextValues)
	fileChanges, err := planTemplateUpdateFiles(root, currentTemplate, nextTemplate, currentValues, nextValues, modules.current, modules.next)
	if err != nil {
		return templateUpdateContext{}, err
	}
	conflictFolder := ".conflicts/" + updateLabel(lock, nextChecksum)
	plan := TemplateUpdatePlan{
		ProjectRoot:    root,
		SourceRoot:     source.Root,
		SourceCommit:   source.Commit,
		FromTemplate:   currentTemplate.Name,
		FromVersion:    lock.Version,
		FromCommit:     lock.Commit,
		FromChecksum:   lock.Checksum,
		ToTemplate:     nextTemplate.Name,
		ToVersion:      nextTemplate.Version,
		ToChecksum:     nextChecksum,
		FromModules:    append([]string{}, modules.current...),
		ToModules:      append([]string{}, modules.next...),
		Values:         valueChanges,
		Files:          fileChanges,
		WouldWrite:     len(valueChanges) > 0 || len(fileChanges) > 0 || lock.Checksum != nextChecksum || lock.Version != nextTemplate.Version,
		ConflictFolder: conflictFolder,
	}
	return templateUpdateContext{
		root:            root,
		lock:            lock,
		currentTemplate: currentTemplate,
		nextTemplate:    nextTemplate,
		sourceRoot:      source.Root,
		sourceCommit:    source.Commit,
		nextChecksum:    nextChecksum,
		currentValues:   currentValues,
		nextValues:      nextValues,
		currentModules:  modules.current,
		nextModules:     modules.next,
		plan:            plan,
	}, nil
}

func ApplyTemplateUpdate(projectRoot string, options TemplateUpdateOptions) (TemplateUpdatePlan, error) {
	context, err := loadTemplateUpdateContext(projectRoot, options)
	if err != nil {
		return TemplateUpdatePlan{}, err
	}
	if err := applyTemplateUpdateFiles(context); err != nil {
		return TemplateUpdatePlan{}, err
	}
	if _, err := writeTemplateValues(context.root, context.nextValues); err != nil {
		return TemplateUpdatePlan{}, err
	}
	targetRoot := filepath.Join(context.root, ".project", "template")
	if err := os.RemoveAll(targetRoot); err != nil {
		return TemplateUpdatePlan{}, err
	}
	if err := copySnapshot(context.sourceRoot, targetRoot); err != nil {
		return TemplateUpdatePlan{}, err
	}
	lock := context.lock
	if strings.Contains(context.lock.Template, "/") && options.TemplatePath == "" {
		lock.Template = context.lock.Template
	} else {
		lock.Template = context.nextTemplate.Name
	}
	lock.Version = context.nextTemplate.Version
	lock.Commit = context.sourceCommit
	lock.Checksum = context.nextChecksum
	lock.ChecksumVersion = templateChecksumVersion
	lock.Modules = append([]string{}, context.nextModules...)
	if options.TemplatePath != "" {
		lock.TemplatePath = options.TemplatePath
	} else if context.sourceCommit != "" {
		lock.TemplatePath = ""
	}
	if _, err := writeTemplateLock(context.root, lock); err != nil {
		return TemplateUpdatePlan{}, err
	}
	return context.plan, nil
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
		if value, ok := lookupTemplateAny(defaults, key); ok {
			setTemplateAny(next, key, cloneTemplateValue(value))
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

func planTemplateUpdateFiles(projectRoot string, current TemplateSpec, next TemplateSpec, currentValues TemplateValues, nextValues TemplateValues, currentModules []string, nextModules []string) ([]TemplateUpdateFileChange, error) {
	currentFiles, err := templateFilesForModules(current, currentModules)
	if err != nil {
		return nil, err
	}
	nextFiles, err := templateFilesForModules(next, nextModules)
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
			before, err := renderedTemplateFile(current, path, currentValues)
			if err != nil {
				return nil, err
			}
			result, err := templateFileUpdateResult(projectRoot, path, before, nil)
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
			result, err := templateFileUpdateResult(projectRoot, path, before, after)
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
	if shouldUnrenderTemplateFile(template, fileSpec.TemplatePath, body) {
		body = placeholder.Unrender(body, template.SelfValues)
	}
	rendered, err := renderTemplateBody(body, values)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return rendered, nil
}

func shouldUnrenderTemplateFile(template TemplateSpec, templatePath string, body []byte) bool {
	return len(template.SelfValues) > 0 && !strings.HasPrefix(templatePath, "template/") && !strings.Contains(templatePath, ".template") && !bytes.Contains(body, []byte("{{"))
}

func templateFileUpdateResult(projectRoot string, path string, base []byte, theirs []byte) (string, error) {
	projectPath := filepath.Join(projectRoot, filepath.FromSlash(path))
	body, err := os.ReadFile(projectPath)
	if os.IsNotExist(err) {
		return "missing", nil
	}
	if err != nil {
		return "", err
	}
	if bytes.Equal(body, base) {
		return "clean", nil
	}
	if theirs == nil {
		return "conflict", nil
	}
	_, clean, err := threeWayMerge(body, base, theirs)
	if err != nil {
		return "", fmt.Errorf("%s: %w", path, err)
	}
	if clean {
		return "merged", nil
	}
	return "conflict", nil
}

func applyTemplateUpdateFiles(context templateUpdateContext) error {
	for _, change := range context.plan.Files {
		switch change.Action {
		case "ADD":
			if change.Result != "clean" {
				if err := writeUpdateConflictCopies(context, change.Path, nil, nil); err != nil {
					return err
				}
				continue
			}
			body, err := renderedTemplateFile(context.nextTemplate, change.Path, context.nextValues)
			if err != nil {
				return err
			}
			if err := writeProjectFile(context.root, change.Path, body); err != nil {
				return err
			}
		case "REMOVE":
			if change.Result == "clean" || change.Result == "missing" {
				if err := os.Remove(filepath.Join(context.root, filepath.FromSlash(change.Path))); err != nil && !os.IsNotExist(err) {
					return err
				}
				removeEmptyParents(context.root, filepath.Dir(filepath.Join(context.root, filepath.FromSlash(change.Path))))
				continue
			}
			if err := writeUpdateConflictCopies(context, change.Path, nil, nil); err != nil {
				return err
			}
		case "UPDATE":
			base, err := renderedTemplateFile(context.currentTemplate, change.Path, context.currentValues)
			if err != nil {
				return err
			}
			theirs, err := renderedTemplateFile(context.nextTemplate, change.Path, context.nextValues)
			if err != nil {
				return err
			}
			projectPath := filepath.Join(context.root, filepath.FromSlash(change.Path))
			mine, err := os.ReadFile(projectPath)
			if os.IsNotExist(err) {
				if err := writeProjectFile(context.root, change.Path, theirs); err != nil {
					return err
				}
				continue
			}
			if err != nil {
				return err
			}
			switch change.Result {
			case "clean":
				if err := writeProjectFile(context.root, change.Path, theirs); err != nil {
					return err
				}
			case "merged":
				merged, _, err := threeWayMerge(mine, base, theirs)
				if err != nil {
					return err
				}
				if err := writeProjectFile(context.root, change.Path, merged); err != nil {
					return err
				}
			case "conflict":
				merged, _, err := threeWayMerge(mine, base, theirs)
				if err != nil {
					return err
				}
				if err := writeUpdateConflictCopies(context, change.Path, base, theirs); err != nil {
					return err
				}
				if err := writeProjectFile(context.root, change.Path, merged); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func writeProjectFile(projectRoot string, path string, body []byte) error {
	target := filepath.Join(projectRoot, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, body, 0o644)
}

func writeUpdateConflictCopies(context templateUpdateContext, path string, base []byte, theirs []byte) error {
	projectPath := filepath.Join(context.root, filepath.FromSlash(path))
	mine, err := os.ReadFile(projectPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if base == nil {
		if rendered, renderErr := renderedTemplateFile(context.currentTemplate, path, context.currentValues); renderErr == nil {
			base = rendered
		}
	}
	if theirs == nil {
		if rendered, renderErr := renderedTemplateFile(context.nextTemplate, path, context.nextValues); renderErr == nil {
			theirs = rendered
		}
	}
	conflictRoot := filepath.Join(context.root, filepath.FromSlash(context.plan.ConflictFolder), filepath.FromSlash(path))
	if len(mine) > 0 {
		if err := writeFile(conflictRoot+".mine", mine); err != nil {
			return err
		}
	}
	if len(base) > 0 {
		if err := writeFile(conflictRoot+".base", base); err != nil {
			return err
		}
	}
	if len(theirs) > 0 {
		if err := writeFile(conflictRoot+".theirs", theirs); err != nil {
			return err
		}
	}
	return nil
}

func threeWayMerge(mine []byte, base []byte, theirs []byte) ([]byte, bool, error) {
	tempDir, err := os.MkdirTemp("", "project-template-merge-*")
	if err != nil {
		return nil, false, err
	}
	defer os.RemoveAll(tempDir)
	minePath := filepath.Join(tempDir, "mine")
	basePath := filepath.Join(tempDir, "base")
	theirsPath := filepath.Join(tempDir, "theirs")
	if err := os.WriteFile(minePath, mine, 0o644); err != nil {
		return nil, false, err
	}
	if err := os.WriteFile(basePath, base, 0o644); err != nil {
		return nil, false, err
	}
	if err := os.WriteFile(theirsPath, theirs, 0o644); err != nil {
		return nil, false, err
	}
	command := exec.Command("git", "merge-file", "-p", minePath, basePath, theirsPath)
	output, err := command.CombinedOutput()
	if err == nil {
		return output, true, nil
	}
	if bytes.Contains(output, []byte("<<<<<<<")) && bytes.Contains(output, []byte(">>>>>>>")) {
		return output, false, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return output, false, nil
	}
	if errors.As(err, &exitErr) {
		return nil, false, fmt.Errorf("git merge-file (exit %d): %s", exitErr.ExitCode(), strings.TrimSpace(string(output)))
	}
	return nil, false, err
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
