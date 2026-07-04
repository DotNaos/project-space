package projectvalidator

import (
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func PlanAdoption(projectRoot string) (AdoptionPlan, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return AdoptionPlan{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return AdoptionPlan{}, err
	}
	template, err := loadTemplate(root, lock)
	if err != nil {
		return AdoptionPlan{}, err
	}
	values, err := readTemplateValues(root)
	if err != nil {
		return AdoptionPlan{}, err
	}

	actualFiles := listProjectFiles(root)
	ignore := readTemplateIgnore(template.Root)
	files := []AdoptionFile{}
	actualPaths := sortedFilePaths(actualFiles)
	blockers, err := adoptionBlockersForFiles(template, actualPaths)
	if err != nil {
		return AdoptionPlan{}, err
	}

	templatePaths := make([]string, 0, len(template.TemplateFiles))
	for path := range template.TemplateFiles {
		templatePaths = append(templatePaths, path)
	}
	sort.Strings(templatePaths)
	waivers, err := adoptionWaiversForFiles(template, lock, uniqueSortedPaths(actualPaths, templatePaths))
	if err != nil {
		return AdoptionPlan{}, err
	}
	for _, path := range templatePaths {
		module := moduleForPath(template, path)
		if !actualFiles[path] {
			if waiver, ok := waivers[path]; ok {
				files = append(files, waiver)
				continue
			}
			files = append(files, AdoptionFile{Path: path, State: "missing", Module: module, Note: "template file is absent"})
			continue
		}
		if blocker, ok := blockers[path]; ok {
			files = append(files, blocker)
			continue
		}
		if waiver, ok := waivers[path]; ok {
			files = append(files, waiver)
			continue
		}
		fileSpec := template.Files[path]
		file := validateTemplateFile(root, template, fileSpec, values)
		state := "match"
		note := "matches rendered template"
		if file.Status != StatusOK {
			state = "drift"
			note = file.Note
		}
		files = append(files, AdoptionFile{Path: path, State: state, Module: module, Note: note})
	}

	for _, path := range actualPaths {
		if blocker, ok := blockers[path]; ok && !template.TemplateFiles[path] {
			files = append(files, blocker)
			continue
		}
		if waiver, ok := waivers[path]; ok && !template.TemplateFiles[path] {
			files = append(files, waiver)
			continue
		}
		if template.TemplateFiles[path] || ignore.Match(path) {
			continue
		}
		if slot, ok := matchingTreeSlot(template.Slots, path); ok {
			files = append(files, AdoptionFile{Path: path, State: "slot", Module: moduleForPath(template, path), Slot: slot.Name, Note: slot.Name})
			continue
		}
		files = append(files, AdoptionFile{Path: path, State: "unknown", Note: "no template file or slot rule"})
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].Path == files[j].Path {
			return files[i].State < files[j].State
		}
		return files[i].Path < files[j].Path
	})

	templateLabel := template.Name + "@" + lock.Version
	if lock.Commit != "" {
		templateLabel = template.Name + "@" + lock.Commit
	}
	return AdoptionPlan{
		ProjectRoot:   root,
		ProjectName:   readProjectName(root),
		TemplateLabel: templateLabel,
		WouldWrite:    false,
		Summary:       adoptionCounts(files),
		Modules:       moduleAdoptionSummaries(template, lock, files),
		Files:         files,
	}, nil
}

func AddAdoptionWaiver(projectRoot string, pathPattern string, reason string, options AdoptionWaiverOptions) (AdoptionWaiverPlan, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return AdoptionWaiverPlan{}, err
	}
	pathPattern = normalizePath(pathPattern)
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return AdoptionWaiverPlan{}, errWaiverReasonRequired()
	}
	match, err := compilePathPattern(pathPattern, nil)
	if err != nil {
		return AdoptionWaiverPlan{}, err
	}
	plan, err := PlanAdoption(root)
	if err != nil {
		return AdoptionWaiverPlan{}, err
	}
	matched := false
	for _, file := range plan.Files {
		if !match.MatchString(file.Path) {
			continue
		}
		matched = true
		if file.State == "blocker" {
			return AdoptionWaiverPlan{}, errWaiverCoversBlocker(file.Path)
		}
	}
	if !matched {
		return AdoptionWaiverPlan{}, errWaiverMatchesNothing(pathPattern)
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return AdoptionWaiverPlan{}, err
	}
	added := options.Today
	if added == "" {
		added = time.Now().Format("2006-01-02")
	}
	result := AdoptionWaiverPlan{
		ProjectRoot: root,
		Path:        pathPattern,
		Reason:      reason,
		Added:       added,
		WouldWrite:  true,
	}
	for _, waiver := range lock.Waivers {
		if waiver.Path == pathPattern {
			result.AlreadyExists = true
			result.Reason = waiver.Reason
			result.Added = waiver.Added
			result.WouldWrite = false
			return result, nil
		}
	}
	if !options.Apply {
		return result, nil
	}
	lock.Waivers = append(lock.Waivers, AdoptionWaiver{Path: pathPattern, Reason: reason, Added: added})
	sort.Slice(lock.Waivers, func(i, j int) bool { return lock.Waivers[i].Path < lock.Waivers[j].Path })
	lockPath, err := writeTemplateLock(root, lock)
	if err != nil {
		return AdoptionWaiverPlan{}, err
	}
	result.LockPath = lockPath
	return result, nil
}

func errWaiverReasonRequired() error {
	return &waiverError{message: "waiver reason is required"}
}

func errWaiverCoversBlocker(path string) error {
	return &waiverError{message: "waiver would cover blocker file " + path}
}

func errWaiverMatchesNothing(path string) error {
	return &waiverError{message: "waiver pattern " + path + " does not match any adoption plan file"}
}

type waiverError struct {
	message string
}

func (err *waiverError) Error() string {
	return err.message
}

func sortedFilePaths(files map[string]bool) []string {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func uniqueSortedPaths(groups ...[]string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, group := range groups {
		for _, path := range group {
			if seen[path] {
				continue
			}
			seen[path] = true
			result = append(result, path)
		}
	}
	sort.Strings(result)
	return result
}

func adoptionWaiversForFiles(template TemplateSpec, lock TemplateLock, paths []string) (map[string]AdoptionFile, error) {
	rules := []compiledAdoptionWaiverRule{}
	for _, waiver := range lock.Waivers {
		regex, err := compilePathPattern(waiver.Path, nil)
		if err != nil {
			return nil, err
		}
		rules = append(rules, compiledAdoptionWaiverRule{
			reason: waiver.Reason,
			added:  waiver.Added,
			match:  regex.MatchString,
		})
	}
	waivers := map[string]AdoptionFile{}
	for _, path := range paths {
		for _, rule := range rules {
			if !rule.match(path) {
				continue
			}
			note := rule.reason
			if rule.added != "" {
				note += " (added " + rule.added + ")"
			}
			waivers[path] = AdoptionFile{Path: path, State: "waived", Module: moduleForPath(template, path), Note: note}
			break
		}
	}
	return waivers, nil
}

type compiledAdoptionWaiverRule struct {
	reason string
	added  string
	match  func(string) bool
}

func adoptionBlockersForFiles(template TemplateSpec, paths []string) (map[string]AdoptionFile, error) {
	rules, err := compileAdoptionBlockerRules(template)
	if err != nil {
		return nil, err
	}
	blockers := map[string]AdoptionFile{}
	for _, path := range paths {
		for _, rule := range rules {
			if !rule.match(path) {
				continue
			}
			blockers[path] = AdoptionFile{
				Path:   path,
				State:  "blocker",
				Module: rule.module,
				Note:   rule.reason,
			}
			break
		}
	}
	return blockers, nil
}

func compileAdoptionBlockerRules(template TemplateSpec) ([]compiledAdoptionBlockerRule, error) {
	names := make([]string, 0, len(template.Modules))
	for name := range template.Modules {
		names = append(names, name)
	}
	sort.Strings(names)
	rules := []compiledAdoptionBlockerRule{}
	for _, name := range names {
		module := template.Modules[name]
		for _, blocker := range module.Blockers {
			regex, err := compilePathPattern(blocker.Path, nil)
			if err != nil {
				return nil, err
			}
			reason := blocker.Reason
			if reason == "" {
				reason = "blocked by template rule"
			}
			rules = append(rules, compiledAdoptionBlockerRule{
				module: name,
				reason: reason,
				match:  regex.MatchString,
			})
		}
	}
	return rules, nil
}

type compiledAdoptionBlockerRule struct {
	module string
	reason string
	match  func(string) bool
}

func moduleAdoptionSummaries(template TemplateSpec, lock TemplateLock, files []AdoptionFile) []ModuleAdoptionSummary {
	installed := installedModuleSet(lock.Modules)
	names := make([]string, 0, len(template.Modules))
	for name := range template.Modules {
		names = append(names, name)
	}
	sort.Strings(names)
	summaries := make([]ModuleAdoptionSummary, 0, len(names))
	for _, name := range names {
		module := template.Modules[name]
		moduleFiles := []AdoptionFile{}
		for _, file := range files {
			if file.Module == name {
				moduleFiles = append(moduleFiles, file)
			}
		}
		summaries = append(summaries, ModuleAdoptionSummary{
			Name:      name,
			Adopted:   installed[name],
			Summary:   adoptionCounts(moduleFiles),
			Owns:      append([]string{}, module.Owns...),
			DependsOn: append([]string{}, module.DependsOn...),
		})
	}
	return summaries
}

func adoptionCounts(files []AdoptionFile) AdoptionCounts {
	counts := AdoptionCounts{}
	for _, file := range files {
		switch file.State {
		case "match":
			counts.Match++
		case "slot":
			counts.Slot++
		case "blocker":
			counts.Blocker++
		case "waived":
			counts.Waived++
		case "missing":
			counts.Missing++
		case "drift":
			counts.Drift++
		case "unknown":
			counts.Unknown++
		}
	}
	return counts
}
