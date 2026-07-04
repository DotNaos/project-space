package projectvalidator

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
)

func ValidateProject(projectRoot string) (Report, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return Report{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return Report{}, err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return Report{}, err
	}
	values, err := readTemplateValues(root)
	if err != nil {
		return Report{}, err
	}
	actualFiles := listProjectFiles(root)
	allPaths := uniqueSortedPaths(sortedFilePaths(actualFiles), templateFilePaths(template))
	blockers, err := adoptionBlockersForFiles(template, sortedFilePaths(actualFiles))
	if err != nil {
		return Report{}, err
	}
	waivers, err := adoptionWaiversForFiles(template, lock, allPaths)
	if err != nil {
		return Report{}, err
	}
	files := []FileValidation{}
	for _, fileSpec := range template.Files {
		if blocker, ok := blockers[fileSpec.Path]; ok {
			files = append(files, validationFromAdoptionFile(blocker, StatusViolation, "blocker"))
			continue
		}
		if waiver, ok := waivers[fileSpec.Path]; ok {
			files = append(files, validationFromAdoptionFile(waiver, StatusWaived, "waived"))
			continue
		}
		file := validateTemplateFile(root, template, fileSpec, values)
		file.Module = moduleForPath(template, file.Path)
		files = append(files, file)
	}
	structure := validateStructure(root, template, files, blockers, waivers)
	files = mergeStructureOnlyFiles(files, structure)
	ok := true
	for _, file := range files {
		if file.Status == StatusMissing || file.Status == StatusViolation {
			ok = false
		}
	}
	for _, entry := range structure {
		if entry.Status == StatusMissing || entry.Status == StatusViolation {
			ok = false
		}
	}
	templateLabel := template.Name + "@" + lock.Version
	if lock.Commit != "" {
		templateLabel = template.Name + "@" + lock.Commit
	}
	return Report{
		ProjectRoot:   root,
		ProjectName:   readProjectName(root),
		TemplateLabel: templateLabel,
		Structure:     structure,
		Files:         files,
		OK:            ok,
	}, nil
}

func ValidateProjectFile(projectRoot string, filePath string) (FileValidation, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return FileValidation{}, err
	}
	normalized := normalizePath(filePath)
	lock, err := readTemplateLock(root)
	if err != nil {
		return FileValidation{}, err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return FileValidation{}, err
	}
	values, err := readTemplateValues(root)
	if err != nil {
		return FileValidation{}, err
	}
	actualFiles := map[string]bool{}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(normalized))); err == nil {
		actualFiles[normalized] = true
	}
	blockers, err := adoptionBlockersForFiles(template, sortedFilePaths(actualFiles))
	if err != nil {
		return FileValidation{}, err
	}
	if blocker, ok := blockers[normalized]; ok {
		return validationFromAdoptionFile(blocker, StatusViolation, "blocker"), nil
	}
	waivers, err := adoptionWaiversForFiles(template, lock, []string{normalized})
	if err != nil {
		return FileValidation{}, err
	}
	if waiver, ok := waivers[normalized]; ok {
		return validationFromAdoptionFile(waiver, StatusWaived, "waived"), nil
	}
	fileSpec, ok := template.Files[normalized]
	if !ok {
		if readTemplateIgnore(template.Root).Match(normalized) {
			return FileValidation{Path: normalized, Status: StatusOK, Code: "ignored", Note: "ignored"}, nil
		}
		if slot, ok := matchingTreeSlot(template.Slots, normalized); ok {
			return FileValidation{Path: normalized, Status: StatusAdded, Code: "slot", Note: slot.Name, Module: moduleForPath(template, normalized)}, nil
		}
		return FileValidation{Path: normalized, Status: StatusViolation, Code: "not_allowed", Note: "not_allowed"}, nil
	}
	file := validateTemplateFile(root, template, fileSpec, values)
	file.Module = moduleForPath(template, file.Path)
	return file, nil
}

func templateFilePaths(template TemplateSpec) []string {
	paths := make([]string, 0, len(template.TemplateFiles))
	for path := range template.TemplateFiles {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func validationFromAdoptionFile(file AdoptionFile, status Status, code string) FileValidation {
	return FileValidation{
		Path:   file.Path,
		Status: status,
		Code:   code,
		Note:   file.Note,
		Module: file.Module,
	}
}

func mergeStructureOnlyFiles(files []FileValidation, structure []StructureEntry) []FileValidation {
	byPath := map[string]FileValidation{}
	for _, file := range files {
		byPath[file.Path] = file
	}
	for _, entry := range structure {
		if entry.Kind != "file" {
			continue
		}
		if _, ok := byPath[entry.Path]; ok {
			continue
		}
		byPath[entry.Path] = FileValidation{Path: entry.Path, Status: entry.Status, Code: entry.Code, Note: entry.Note, Module: entry.Module}
	}
	result := make([]FileValidation, 0, len(byPath))
	for _, file := range byPath {
		result = append(result, file)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result
}

func readProjectName(projectRoot string) string {
	body, err := os.ReadFile(filepath.Join(projectRoot, "package.json"))
	if err != nil {
		return filepath.Base(projectRoot)
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &pkg); err != nil || pkg.Name == "" {
		return filepath.Base(projectRoot)
	}
	return pkg.Name
}
