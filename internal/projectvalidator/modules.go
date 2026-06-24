package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func InstallModule(projectRoot string, moduleName string, options ModuleInstallOptions) (ModuleInstallPlan, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return ModuleInstallPlan{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return ModuleInstallPlan{}, err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return ModuleInstallPlan{}, err
	}
	if len(template.Modules) == 0 {
		return ModuleInstallPlan{}, fmt.Errorf("template %s does not define modules yet", template.Name)
	}
	if _, ok := template.Modules[moduleName]; !ok {
		return ModuleInstallPlan{}, fmt.Errorf("unknown module %q", moduleName)
	}

	installed := installedModuleSet(lock.Modules)
	closure, err := moduleInstallClosure(template.Modules, moduleName)
	if err != nil {
		return ModuleInstallPlan{}, err
	}

	plan := ModuleInstallPlan{ProjectRoot: root, Module: moduleName}
	for _, module := range lock.Modules {
		if installed[module] {
			plan.AlreadyInstalled = append(plan.AlreadyInstalled, module)
		}
	}
	for _, module := range closure {
		if installed[module] {
			continue
		}
		plan.ToInstall = append(plan.ToInstall, module)
	}
	files, conflicts, err := moduleInstallFiles(root, template, plan.ToInstall)
	if err != nil {
		return ModuleInstallPlan{}, err
	}
	plan.Files = files
	plan.Conflicts = conflicts
	if len(plan.Conflicts) > 0 && !options.Force {
		return ModuleInstallPlan{}, fmt.Errorf("module add would overwrite existing project files: %s; rerun with --force to allow this", formatModuleConflicts(plan.Conflicts))
	}
	plan.WouldWrite = len(plan.ToInstall) > 0
	if !options.Apply || options.DryRun {
		return plan, nil
	}

	values, err := readTemplateValues(root)
	if err != nil {
		return ModuleInstallPlan{}, err
	}
	if err := applyModuleFiles(root, template, values, plan.Files); err != nil {
		return ModuleInstallPlan{}, err
	}
	nextModules := append([]string{}, lock.Modules...)
	nextModules = append(nextModules, plan.ToInstall...)
	nextModules = uniqueSortedModules(nextModules)
	lock.Modules = nextModules
	lockPath, err := writeTemplateLock(root, lock)
	if err != nil {
		return ModuleInstallPlan{}, err
	}
	plan.LockPath = lockPath
	return plan, nil
}

func applyModuleFiles(projectRoot string, template TemplateSpec, values TemplateValues, files []ModuleInstallFile) error {
	for _, file := range files {
		sourcePath := filepath.Join(template.Root, filepath.FromSlash(file.Path))
		body, err := os.ReadFile(sourcePath)
		if err != nil {
			return err
		}
		rendered, err := renderTemplateValues(body, values)
		if err != nil {
			return fmt.Errorf("%s: %w", file.Path, err)
		}
		targetPath := filepath.Join(projectRoot, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, rendered, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func ListModules(projectRoot string) ([]string, error) {
	infos, err := ListModuleInfos(projectRoot)
	if err != nil {
		return nil, err
	}
	modules := make([]string, 0, len(infos))
	for _, info := range infos {
		modules = append(modules, info.Name)
	}
	return modules, nil
}

func ListModuleInfos(projectRoot string) ([]ModuleInfo, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return nil, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return nil, err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return nil, err
	}
	installed := installedModuleSet(lock.Modules)
	names := make([]string, 0, len(template.Modules))
	for name := range template.Modules {
		names = append(names, name)
	}
	sort.Strings(names)
	infos := make([]ModuleInfo, 0, len(names))
	for _, name := range names {
		module := template.Modules[name]
		files, err := moduleTemplateFiles(template, name)
		if err != nil {
			return nil, err
		}
		infos = append(infos, ModuleInfo{
			Name:        name,
			Description: module.Description,
			Installed:   installed[name],
			Default:     module.Default,
			DependsOn:   append([]string{}, module.DependsOn...),
			Owns:        append([]string{}, module.Owns...),
			Files:       files,
		})
	}
	return infos, nil
}

func moduleInstallFiles(projectRoot string, template TemplateSpec, modules []string) ([]ModuleInstallFile, []ModuleInstallConflict, error) {
	installFiles := []ModuleInstallFile{}
	conflicts := []ModuleInstallConflict{}
	for _, moduleName := range modules {
		files, err := moduleTemplateFiles(template, moduleName)
		if err != nil {
			return nil, nil, err
		}
		for _, path := range files {
			action := "ADD"
			projectPath := filepath.Join(projectRoot, filepath.FromSlash(path))
			if stat, err := os.Stat(projectPath); err == nil && !stat.IsDir() {
				action = "OVERWRITE"
				conflicts = append(conflicts, ModuleInstallConflict{Module: moduleName, Path: path})
			}
			installFiles = append(installFiles, ModuleInstallFile{Action: action, Module: moduleName, Path: path})
		}
	}
	sort.Slice(installFiles, func(i, j int) bool {
		if installFiles[i].Path == installFiles[j].Path {
			return installFiles[i].Module < installFiles[j].Module
		}
		return installFiles[i].Path < installFiles[j].Path
	})
	sort.Slice(conflicts, func(i, j int) bool {
		if conflicts[i].Path == conflicts[j].Path {
			return conflicts[i].Module < conflicts[j].Module
		}
		return conflicts[i].Path < conflicts[j].Path
	})
	return installFiles, conflicts, nil
}

func moduleTemplateFiles(template TemplateSpec, moduleName string) ([]string, error) {
	module, ok := template.Modules[moduleName]
	if !ok {
		return nil, fmt.Errorf("unknown module %q", moduleName)
	}
	rules := []*ownRule{}
	for _, pattern := range module.Owns {
		regex, err := compilePathPattern(pattern, nil)
		if err != nil {
			return nil, fmt.Errorf("module %s owns pattern %q: %w", moduleName, pattern, err)
		}
		rules = append(rules, &ownRule{match: regex.MatchString})
	}
	if len(rules) == 0 {
		return nil, nil
	}
	files := []string{}
	for path := range template.Files {
		for _, rule := range rules {
			if rule.match(path) {
				files = append(files, path)
				break
			}
		}
	}
	sort.Strings(files)
	return files, nil
}

type ownRule struct {
	match func(string) bool
}

func formatModuleConflicts(conflicts []ModuleInstallConflict) string {
	parts := make([]string, 0, len(conflicts))
	for _, conflict := range conflicts {
		parts = append(parts, conflict.Path+" ("+conflict.Module+")")
	}
	return strings.Join(parts, ", ")
}

func installedModuleSet(modules []string) map[string]bool {
	installed := map[string]bool{}
	for _, module := range modules {
		installed[module] = true
	}
	return installed
}

func moduleInstallClosure(modules map[string]TemplateModuleSpec, moduleName string) ([]string, error) {
	visited := map[string]bool{}
	visiting := map[string]bool{}
	result := []string{}
	var visit func(string) error
	visit = func(name string) error {
		if visited[name] {
			return nil
		}
		if visiting[name] {
			return fmt.Errorf("module dependency cycle at %q", name)
		}
		module, ok := modules[name]
		if !ok {
			return fmt.Errorf("unknown dependency module %q", name)
		}
		visiting[name] = true
		for _, dependency := range module.DependsOn {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		visiting[name] = false
		visited[name] = true
		result = append(result, name)
		return nil
	}
	if err := visit(moduleName); err != nil {
		return nil, err
	}
	return result, nil
}

func uniqueSortedModules(modules []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, module := range modules {
		if seen[module] {
			continue
		}
		seen[module] = true
		result = append(result, module)
	}
	sort.Strings(result)
	return result
}
