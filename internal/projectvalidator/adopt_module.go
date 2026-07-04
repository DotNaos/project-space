package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

func AdoptModule(projectRoot string, moduleName string, options AdoptionModuleOptions) (AdoptionModulePlan, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	if len(template.Modules) == 0 {
		return AdoptionModulePlan{}, fmt.Errorf("template %s does not define modules yet", template.Name)
	}
	if _, ok := template.Modules[moduleName]; !ok {
		return AdoptionModulePlan{}, fmt.Errorf("unknown module %q", moduleName)
	}

	closure, err := moduleInstallClosure(template.Modules, moduleName)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	installed := installedModuleSet(lock.Modules)
	plan := AdoptionModulePlan{ProjectRoot: root, Module: moduleName}
	for _, module := range closure {
		if installed[module] {
			plan.AlreadyAdopted = append(plan.AlreadyAdopted, module)
			continue
		}
		plan.ToAdopt = append(plan.ToAdopt, module)
	}

	files, err := adoptionModuleMissingFiles(root, template, lock, closure)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	plan.Files = files
	plan.WouldWrite = len(plan.ToAdopt) > 0 || len(plan.Files) > 0
	if !options.Apply || options.DryRun || !plan.WouldWrite {
		return plan, nil
	}

	values, err := readTemplateValues(root)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	nextModules := append([]string{}, lock.Modules...)
	nextModules = append(nextModules, plan.ToAdopt...)
	nextModules = uniqueSortedModules(nextModules)
	values, err = mergeTemplateValuesForModules(root, template, nextModules, values)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	if err := applyAdoptionModuleFiles(root, template, values, plan.Files); err != nil {
		return AdoptionModulePlan{}, err
	}
	if _, err := writeTemplateValues(root, values); err != nil {
		return AdoptionModulePlan{}, err
	}
	lock.Modules = nextModules
	lockPath, err := writeTemplateLock(root, lock)
	if err != nil {
		return AdoptionModulePlan{}, err
	}
	plan.LockPath = lockPath
	return plan, nil
}

func adoptionModuleMissingFiles(projectRoot string, template TemplateSpec, lock TemplateLock, modules []string) ([]AdoptionModuleFile, error) {
	actualFiles := listProjectFiles(projectRoot)
	modulePaths := []string{}
	pathModule := map[string]string{}
	for _, moduleName := range modules {
		files, err := moduleTemplateFiles(template, moduleName)
		if err != nil {
			return nil, err
		}
		for _, path := range files {
			if _, seen := pathModule[path]; seen {
				continue
			}
			pathModule[path] = moduleName
			modulePaths = append(modulePaths, path)
		}
	}
	sort.Strings(modulePaths)

	waivers, err := adoptionWaiversForFiles(template, lock, modulePaths)
	if err != nil {
		return nil, err
	}
	result := []AdoptionModuleFile{}
	for _, path := range modulePaths {
		if actualFiles[path] {
			continue
		}
		if _, ok := waivers[path]; ok {
			continue
		}
		result = append(result, AdoptionModuleFile{Action: "ADD", Module: pathModule[path], Path: path})
	}
	return result, nil
}

func applyAdoptionModuleFiles(projectRoot string, template TemplateSpec, values TemplateValues, files []AdoptionModuleFile) error {
	for _, file := range files {
		if file.Action != "ADD" {
			continue
		}
		targetPath := filepath.Join(projectRoot, filepath.FromSlash(file.Path))
		if stat, err := os.Stat(targetPath); err == nil && !stat.IsDir() {
			return fmt.Errorf("adoption would overwrite existing project file %s; rerun the plan", file.Path)
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		fileSpec, ok := template.Files[file.Path]
		if !ok {
			return fmt.Errorf("template file %s is not defined", file.Path)
		}
		sourcePath := filepath.Join(template.Root, filepath.FromSlash(fileSpec.TemplatePath))
		body, err := os.ReadFile(sourcePath)
		if err != nil {
			return err
		}
		rendered, err := renderTemplateBody(body, values)
		if err != nil {
			return fmt.Errorf("%s: %w", file.Path, err)
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, rendered, 0o644); err != nil {
			return err
		}
	}
	return nil
}
