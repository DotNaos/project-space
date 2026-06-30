package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

type InitOptions struct {
	Template     string
	TemplatePath string
	Version      string
	Commit       string
	Force        bool
}

func WriteTmpTemplateValues(projectRoot string) (string, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return "", err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return "", err
	}
	modules, err := defaultModuleClosure(template.Modules)
	if err != nil {
		return "", err
	}
	values, err := defaultTemplateValuesForProject(root, template, modules)
	if err != nil {
		return "", err
	}
	return writeTemplateValues(root, values)
}

func defaultModuleClosure(modules map[string]TemplateModuleSpec) ([]string, error) {
	installed := []string{}
	for name, module := range modules {
		if !module.Default {
			continue
		}
		closure, err := moduleInstallClosure(modules, name)
		if err != nil {
			return nil, err
		}
		installed = append(installed, closure...)
	}
	return uniqueSortedModules(installed), nil
}

func InstallDefaultModules(projectRoot string) ([]ModuleInstallPlan, error) {
	infos, err := ListModuleInfos(projectRoot)
	if err != nil {
		return nil, err
	}
	plans := []ModuleInstallPlan{}
	for _, info := range infos {
		if !info.Default || info.Installed {
			continue
		}
		plan, err := InstallModule(projectRoot, info.Name, ModuleInstallOptions{Apply: true})
		if err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	return plans, nil
}

func CreateProject(projectRoot string, options InitOptions) (string, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", err
	}
	if stat, err := os.Stat(root); err == nil {
		if !stat.IsDir() {
			return "", fmt.Errorf("%s already exists and is not a directory", root)
		}
		empty, err := isEmptyDirectory(root)
		if err != nil {
			return "", err
		}
		if !empty {
			return "", fmt.Errorf("%s already exists and is not empty; use init for existing projects", root)
		}
	} else if os.IsNotExist(err) {
		if err := os.MkdirAll(root, 0o755); err != nil {
			return "", err
		}
	} else {
		return "", err
	}
	return InitProject(root, options)
}

func InitProject(projectRoot string, options InitOptions) (string, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", err
	}
	template := options.Template
	if template == "" {
		template = "DotNaos/project-template"
	}
	commit := options.Commit
	if commit == "" {
		commit = "local"
	}
	templatePath, err := resolveInitTemplatePath(root, options.TemplatePath)
	if err != nil {
		return "", err
	}
	sourceRoot, err := resolveTemplatePathFromLockPath(root, templatePath)
	if err != nil {
		return "", err
	}
	sourceTemplate, err := loadTemplateFromRoot(sourceRoot)
	if err != nil {
		return "", err
	}
	version := options.Version
	if version == "" {
		version = sourceTemplate.Version
	}
	lockPath := filepath.Join(root, ".project", "template.lock.yaml")
	if _, err := os.Stat(lockPath); err == nil && !options.Force {
		return "", fmt.Errorf("%s already exists; use --force to replace it", lockPath)
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return "", err
	}
	targetRoot := filepath.Join(root, ".project", "template")
	if err := os.RemoveAll(targetRoot); err != nil {
		return "", err
	}
	if err := copyDirectory(sourceRoot, targetRoot); err != nil {
		return "", err
	}
	checksum, err := checksumTemplateRoot(targetRoot)
	if err != nil {
		return "", err
	}
	lock := TemplateLock{
		Template:     template,
		Version:      version,
		Commit:       commit,
		Checksum:     checksum,
		TemplatePath: templatePath,
	}
	if _, err := writeTemplateLock(root, lock); err != nil {
		return "", err
	}
	targetTemplate, err := loadTemplateFromRoot(targetRoot)
	if err != nil {
		return "", err
	}
	if _, err := ensureTemplateValues(root, targetTemplate, lock.Modules); err != nil {
		return "", err
	}
	return lockPath, nil
}

func isEmptyDirectory(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

func writeTemplateLock(projectRoot string, lock TemplateLock) (string, error) {
	lockPath := filepath.Join(projectRoot, ".project", "template.lock.yaml")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return "", err
	}
	body, err := marshalYAML(lock)
	if err != nil {
		return "", err
	}
	return lockPath, os.WriteFile(lockPath, body, 0o644)
}

func resolveInitTemplatePath(projectRoot string, requestedPath string) (string, error) {
	templateRoot := requestedPath
	if templateRoot == "" {
		templateRoot = os.Getenv("PROJECT_SPACE_TEMPLATE_ROOT")
	}
	if templateRoot == "" {
		templateRoot = filepath.Join(mustWorkingDirectory(), "templates", "project-template")
	}
	absTemplateRoot, err := filepath.Abs(templateRoot)
	if err != nil {
		return "", err
	}
	if !hasTemplateManifest(absTemplateRoot) {
		return "", fmt.Errorf("template path %s does not contain template/manifest.yaml or template.yaml", absTemplateRoot)
	}
	projectRelativeTemplatePath, err := filepath.Rel(projectRoot, absTemplateRoot)
	if err == nil && !isParentRelative(projectRelativeTemplatePath) {
		lockDir := filepath.Join(projectRoot, ".project")
		relativeTemplatePath, err := filepath.Rel(lockDir, absTemplateRoot)
		if err == nil {
			return filepath.ToSlash(relativeTemplatePath), nil
		}
	}
	return absTemplateRoot, nil
}

func resolveTemplatePathFromLockPath(projectRoot string, templatePath string) (string, error) {
	if filepath.IsAbs(templatePath) {
		return filepath.Abs(templatePath)
	}
	return filepath.Abs(filepath.Join(projectRoot, ".project", templatePath))
}

func isParentRelative(pathValue string) bool {
	return pathValue == ".." || strings.HasPrefix(pathValue, ".."+string(filepath.Separator)) || strings.HasPrefix(filepath.ToSlash(pathValue), "../")
}

func mustWorkingDirectory() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func slugify(value string) string {
	parts := []rune{}
	lastWasDash := false
	for _, char := range strings.ToLower(value) {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9':
			parts = append(parts, char)
			lastWasDash = false
		case !lastWasDash:
			parts = append(parts, '-')
			lastWasDash = true
		}
	}
	return strings.Trim(string(parts), "-")
}

func displayNameFromSlug(slug string) string {
	words := strings.Split(slug, "-")
	for index, word := range words {
		if word == "" {
			continue
		}
		runes := []rune(word)
		runes[0] = unicode.ToUpper(runes[0])
		words[index] = string(runes)
	}
	return strings.Join(words, " ")
}
