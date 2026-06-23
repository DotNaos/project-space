package projectvalidator

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type slotRule struct {
	placeholder string
	regex       *regexpWrapper
}

type regexpWrapper struct {
	match func(string) bool
}

func validateStructure(projectRoot string, template TemplateSpec, files []FileValidation) []StructureEntry {
	structureLines := readStructureLines(filepath.Join(template.Root, template.StructurePath))
	slotPatterns, _ := readJSONFile[map[string]string](filepath.Join(template.Root, template.StructureSlotsPath))
	fixedPaths := map[string]bool{}
	slotRules := []slotRule{}

	for _, line := range structureLines {
		if anyPlaceholderRE.MatchString(line) {
			compiled, err := compileTemplateRegex(line, slotPatterns)
			if err == nil {
				placeholder := "unknown"
				if len(compiled.placeholders) > 0 {
					placeholder = compiled.placeholders[0]
				}
				slotRules = append(slotRules, slotRule{placeholder: placeholder, regex: &regexpWrapper{match: compiled.regex.MatchString}})
			}
			continue
		}
		fixedPaths[normalizePath(line)] = true
	}

	fileStatusByPath := map[string]FileValidation{}
	for _, file := range files {
		fileStatusByPath[file.Path] = file
	}
	actualFiles := listProjectFiles(projectRoot)
	entries := map[string]StructureEntry{}

	for fixedPath := range fixedPaths {
		fileStatus, hasFileStatus := fileStatusByPath[fixedPath]
		if !actualFiles[fixedPath] {
			entries[fixedPath] = StructureEntry{Path: fixedPath, Kind: "file", Status: StatusMissing, Code: "missing", Note: "missing"}
			continue
		}
		status := StatusOK
		code := "template"
		note := "template"
		if hasFileStatus {
			status = fileStatus.Status
			code = fileStatus.Code
			note = fileStatus.Note
		}
		entries[fixedPath] = StructureEntry{Path: fixedPath, Kind: "file", Status: status, Code: code, Note: note}
	}

	for actualFile := range actualFiles {
		if fixedPaths[actualFile] {
			continue
		}
		if rule, ok := matchingSlot(slotRules, actualFile); ok {
			entries[actualFile] = StructureEntry{Path: actualFile, Kind: "file", Status: StatusAdded, Code: "slot", Note: rule.placeholder, Slot: rule.placeholder}
			continue
		}
		entries[actualFile] = StructureEntry{Path: actualFile, Kind: "file", Status: StatusViolation, Code: "not_allowed", Note: "not_allowed"}
	}

	addParentDirectories(entries)
	result := make([]StructureEntry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result
}

func readStructureLines(filePath string) []string {
	body, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}
	lines := []string{}
	for _, line := range strings.Split(string(body), "\n") {
		normalized := normalizePath(strings.TrimSpace(line))
		if normalized != "" {
			lines = append(lines, normalized)
		}
	}
	return lines
}

func listProjectFiles(projectRoot string) map[string]bool {
	files := map[string]bool{}
	_ = filepath.WalkDir(projectRoot, func(filePath string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == ".project" || entry.Name() == "node_modules") {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(projectRoot, filePath)
		if err == nil {
			files[normalizePath(relative)] = true
		}
		return nil
	})
	return files
}

func matchingSlot(rules []slotRule, filePath string) (slotRule, bool) {
	for _, rule := range rules {
		if rule.regex.match(filePath) {
			return rule, true
		}
	}
	return slotRule{}, false
}

func addParentDirectories(entries map[string]StructureEntry) {
	for _, entry := range entries {
		segments := strings.Split(entry.Path, "/")
		for index := 1; index < len(segments); index++ {
			dir := strings.Join(segments[:index], "/")
			if _, ok := entries[dir]; ok {
				continue
			}
			code := "template"
			note := "template"
			if entry.Slot != "" {
				code = "slot"
				note = entry.Slot
			}
			entries[dir] = StructureEntry{Path: dir, Kind: "dir", Status: StatusOK, Code: code, Note: note, Slot: entry.Slot}
		}
	}
}

func normalizePath(value string) string {
	value = filepath.ToSlash(value)
	value = strings.TrimPrefix(value, "./")
	return strings.TrimSuffix(value, "/")
}
