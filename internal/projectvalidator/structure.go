package projectvalidator

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func validateStructure(projectRoot string, template TemplateSpec, expectedFiles map[string]bool, files []FileValidation, blockers map[string]AdoptionFile, waivers map[string]AdoptionFile) []StructureEntry {
	fileStatusByPath := map[string]FileValidation{}
	for _, file := range files {
		fileStatusByPath[file.Path] = file
	}
	actualFiles := listProjectFiles(projectRoot)
	ignore := readTemplateIgnore(template.Root)
	entries := map[string]StructureEntry{}

	for templateFile := range expectedFiles {
		fileStatus, hasFileStatus := fileStatusByPath[templateFile]
		if !actualFiles[templateFile] {
			entries[templateFile] = StructureEntry{Path: templateFile, Kind: "file", Status: StatusMissing, Code: "missing", Note: "missing", Module: moduleForPath(template, templateFile)}
			continue
		}
		status := StatusOK
		code := "template"
		note := "template"
		module := moduleForPath(template, templateFile)
		if hasFileStatus {
			status = fileStatus.Status
			code = fileStatus.Code
			note = fileStatus.Note
			module = fileStatus.Module
		}
		entries[templateFile] = StructureEntry{Path: templateFile, Kind: "file", Status: status, Code: code, Note: note, Module: module}
	}

	for actualFile := range actualFiles {
		if expectedFiles[actualFile] {
			continue
		}
		if blocker, ok := blockers[actualFile]; ok {
			entries[actualFile] = StructureEntry{Path: actualFile, Kind: "file", Status: StatusViolation, Code: "blocker", Note: blocker.Note, Module: blocker.Module}
			continue
		}
		if waiver, ok := waivers[actualFile]; ok {
			entries[actualFile] = StructureEntry{Path: actualFile, Kind: "file", Status: StatusWaived, Code: "waived", Note: waiver.Note, Module: waiver.Module}
			continue
		}
		if ignore.Match(actualFile) {
			continue
		}
		if slot, ok := matchingTreeSlot(template.Slots, actualFile); ok {
			entries[actualFile] = StructureEntry{Path: actualFile, Kind: "file", Status: StatusAdded, Code: "slot", Note: slot.Name, Slot: slot.Name, Module: moduleForPath(template, actualFile)}
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

func matchingTreeSlot(rules []SlotRule, filePath string) (SlotRule, bool) {
	for _, rule := range rules {
		if rule.Match(filePath) {
			return rule, true
		}
	}
	return SlotRule{}, false
}

func addParentDirectories(entries map[string]StructureEntry) {
	for _, entry := range entries {
		segments := strings.Split(entry.Path, "/")
		for index := 1; index < len(segments); index++ {
			dir := strings.Join(segments[:index], "/")
			existing, ok := entries[dir]
			if ok && !(existing.Code == "slot" && entry.Code == "template") {
				continue
			}
			code := "template"
			note := "template"
			if entry.Slot != "" {
				code = "slot"
				note = entry.Slot
			}
			entries[dir] = StructureEntry{Path: dir, Kind: "dir", Status: StatusOK, Code: code, Note: note, Slot: entry.Slot, Module: entry.Module}
		}
	}
}

func normalizePath(value string) string {
	value = filepath.ToSlash(value)
	value = strings.TrimPrefix(value, "./")
	return strings.TrimSuffix(value, "/")
}
