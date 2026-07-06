package projectvalidator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type ColorScope string
type ViewMode string
type OutputFormat string

const (
	ColorScopeLine     ColorScope   = "line"
	ColorScopeStatus   ColorScope   = "status"
	ViewModeTree       ViewMode     = "tree"
	ViewModeTable      ViewMode     = "table"
	OutputFormatPretty OutputFormat = "pretty"
	OutputFormatTSV    OutputFormat = "tsv"
	OutputFormatJSON   OutputFormat = "json"
)

type OutputOptions struct {
	ColorScope ColorScope
	View       ViewMode
	Format     OutputFormat
}

func DefaultOutputOptions() OutputOptions {
	return OutputOptions{ColorScope: ColorScopeLine, View: ViewModeTree, Format: OutputFormatPretty}
}

func PrintProjectReport(report Report) {
	PrintProjectReportWithOptions(report, DefaultOutputOptions())
}

func PrintProjectReportWithOptions(report Report, options OutputOptions) {
	if options.Format == OutputFormatJSON {
		printProjectJSON(report)
		return
	}
	if options.Format == OutputFormatTSV {
		printProjectTSV(report)
		return
	}
	fmt.Printf("Project: %s\n", report.ProjectName)
	fmt.Printf("Template: %s\n\n", report.TemplateLabel)
	switch options.View {
	case ViewModeTable:
		fmt.Println("Status")
		fmt.Println()
		printTable(report, options)
	default:
		fmt.Println("Structure")
		fmt.Println()
		printTree(report, options)
	}
	fmt.Println()
	if report.OK {
		fmt.Println(color("Result: project adheres to template.", "green"))
		return
	}
	fmt.Println(color("Result: project does not adhere to template.", "red"))
}

func PrintFileReport(report FileValidation) {
	PrintFileReportWithOptions(report, DefaultOutputOptions())
}

func PrintFileReportWithOptions(report FileValidation, options OutputOptions) {
	if options.Format == OutputFormatJSON {
		printFileJSON(report)
		return
	}
	if options.Format == OutputFormatTSV {
		printFileTSV(report)
		return
	}
	fmt.Println(report.Path)
	fmt.Println()
	printStatusLine(report.Path, report.Status, fileModuleDetail(report), options)
	for _, diagnostic := range report.Diagnostics {
		printStatusLine(diagnostic.Path, diagnostic.Status, diagnostic.Note, options)
	}
	fmt.Println()
	if report.Status == StatusOK {
		fmt.Println(color("Result: "+report.Path+" adheres to template.", "green"))
		return
	}
	fmt.Println(color("Result: "+report.Path+" violates template.", "red"))
}

func printTable(report Report, options OutputOptions) {
	for _, file := range report.Files {
		printStatusLine(file.Path, file.Status, fileModuleDetail(file), options)
		for _, diagnostic := range file.Diagnostics {
			if diagnostic.Status == StatusViolation {
				printStatusLine("  "+diagnostic.Path, diagnostic.Status, diagnostic.Note, options)
			}
		}
	}
}

type jsonStructureEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Status Status `json:"status"`
	Code   string `json:"code,omitempty"`
	Note   string `json:"note,omitempty"`
	Slot   string `json:"slot,omitempty"`
	Module string `json:"module,omitempty"`
}

type jsonFileDiagnostic struct {
	Path   string `json:"path"`
	Status Status `json:"status"`
	Note   string `json:"note,omitempty"`
}

type jsonFileValidation struct {
	Path        string               `json:"path"`
	Status      Status               `json:"status"`
	Code        string               `json:"code,omitempty"`
	Note        string               `json:"note,omitempty"`
	Module      string               `json:"module,omitempty"`
	Diagnostics []jsonFileDiagnostic `json:"diagnostics,omitempty"`
}

type jsonReportSummary struct {
	Total     int `json:"total"`
	OK        int `json:"ok"`
	Added     int `json:"added"`
	Missing   int `json:"missing"`
	Changed   int `json:"changed"`
	Waived    int `json:"waived"`
	Violation int `json:"violation"`
}

type jsonProjectReport struct {
	ProjectRoot   string               `json:"projectRoot"`
	ProjectName   string               `json:"projectName"`
	TemplateLabel string               `json:"templateLabel"`
	OK            bool                 `json:"ok"`
	Summary       jsonReportSummary    `json:"summary"`
	Structure     []jsonStructureEntry `json:"structure"`
	Files         []jsonFileValidation `json:"files"`
}

func projectReportJSON(report Report) jsonProjectReport {
	payload := jsonProjectReport{
		ProjectRoot:   filepath.ToSlash(report.ProjectRoot),
		ProjectName:   report.ProjectName,
		TemplateLabel: report.TemplateLabel,
		OK:            report.OK,
		Structure:     []jsonStructureEntry{},
		Files:         []jsonFileValidation{},
	}
	for _, entry := range report.Structure {
		payload.Structure = append(payload.Structure, jsonStructureEntry{
			Path:   entry.Path,
			Kind:   entry.Kind,
			Status: entry.Status,
			Code:   entry.Code,
			Note:   entry.Note,
			Slot:   entry.Slot,
			Module: entry.Module,
		})
		payload.Summary.Total++
		switch entry.Status {
		case StatusOK:
			payload.Summary.OK++
		case StatusAdded:
			payload.Summary.Added++
		case StatusMissing:
			payload.Summary.Missing++
		case StatusChanged:
			payload.Summary.Changed++
		case StatusWaived:
			payload.Summary.Waived++
		case StatusViolation:
			payload.Summary.Violation++
		}
	}
	for _, file := range report.Files {
		payload.Files = append(payload.Files, fileValidationJSON(file))
	}
	return payload
}

func fileValidationJSON(file FileValidation) jsonFileValidation {
	converted := jsonFileValidation{
		Path:   file.Path,
		Status: file.Status,
		Code:   file.Code,
		Note:   file.Note,
		Module: file.Module,
	}
	for _, diagnostic := range file.Diagnostics {
		converted.Diagnostics = append(converted.Diagnostics, jsonFileDiagnostic{
			Path:   diagnostic.Path,
			Status: diagnostic.Status,
			Note:   diagnostic.Note,
		})
	}
	return converted
}

func printProjectJSON(report Report) {
	printJSON(projectReportJSON(report))
}

func printFileJSON(report FileValidation) {
	printJSON(fileValidationJSON(report))
}

func printJSON(payload any) {
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not encode report as JSON: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
}

func printProjectTSV(report Report) {
	fmt.Println("status\tkind\tpath\tcode\tmodule")
	for _, entry := range report.Structure {
		fmt.Printf("%s\t%s\t%s\t%s\t%s\n", entry.Status, entry.Kind, entry.Path, entry.Code, structureModuleDetail(entry))
	}
	if report.OK {
		fmt.Println("RESULT\tresult\t.\tok\tproject adheres to template")
		return
	}
	fmt.Println("RESULT\tresult\t.\tviolation\tproject does not adhere to template")
}

func printFileTSV(report FileValidation) {
	fmt.Println("status\tkind\tpath\tcode\tmodule")
	fmt.Printf("%s\tfile\t%s\t%s\t%s\n", report.Status, report.Path, report.Code, fileModuleDetail(report))
	for _, diagnostic := range report.Diagnostics {
		fmt.Printf("%s\tdiagnostic\t%s\t%s\t%s\n", diagnostic.Status, diagnostic.Path, diagnostic.Status, diagnostic.Note)
	}
}

type treeNode struct {
	name     string
	entry    *StructureEntry
	children map[string]*treeNode
}

func printTree(report Report, options OutputOptions) {
	root := &treeNode{children: map[string]*treeNode{}}
	for _, entry := range report.Structure {
		node := root
		for _, segment := range strings.Split(entry.Path, "/") {
			child, ok := node.children[segment]
			if !ok {
				child = &treeNode{name: segment, children: map[string]*treeNode{}}
				node.children[segment] = child
			}
			node = child
		}
		entryCopy := entry
		node.entry = &entryCopy
	}
	fmt.Println(filepath.Base(report.ProjectRoot) + "/")
	printTreeChildren(root, "", options)
}

func printTreeChildren(node *treeNode, prefix string, options OutputOptions) {
	children := make([]*treeNode, 0, len(node.children))
	for _, child := range node.children {
		children = append(children, child)
	}
	sort.Slice(children, func(i, j int) bool {
		leftDir := len(children[i].children) > 0
		rightDir := len(children[j].children) > 0
		if leftDir != rightDir {
			return leftDir
		}
		return children[i].name < children[j].name
	})
	for index, child := range children {
		last := index == len(children)-1
		branch := "├── "
		nextPrefix := prefix + "│   "
		if last {
			branch = "└── "
			nextPrefix = prefix + "    "
		}
		entry := child.entry
		if entry == nil {
			entry = &StructureEntry{Kind: "dir", Status: StatusOK, Code: "template", Note: "template"}
		}
		label := child.name
		if entry.Kind == "dir" {
			label += "/"
		}
		printStatusLine(prefix+branch+label, entry.Status, structureModuleDetail(*entry), options)
		printTreeChildren(child, nextPrefix, options)
	}
}

func structureModuleDetail(entry StructureEntry) string {
	if entry.Module != "" {
		return entry.Module
	}
	if entry.Code == "template" || entry.Code == "missing" {
		return "template"
	}
	return "-"
}

func fileModuleDetail(file FileValidation) string {
	if file.Module != "" {
		return file.Module
	}
	if file.Code == "template" || file.Code == "missing" {
		return "template"
	}
	return "-"
}

func printStatusLine(label string, status Status, note string, options OutputOptions) {
	if utf8.RuneCountInString(label) >= 44 {
		if options.ColorScope == ColorScopeStatus {
			fmt.Printf("%s %s%s\n", label, color(fmt.Sprintf("%-10s", status), statusColor(status)), note)
			return
		}
		line := fmt.Sprintf("%s %-10s%s", label, status, note)
		fmt.Println(color(line, statusColor(status)))
		return
	}
	if options.ColorScope == ColorScopeStatus {
		fmt.Printf("%-44s%s%s\n", label, color(fmt.Sprintf("%-10s", status), statusColor(status)), note)
		return
	}
	line := fmt.Sprintf("%-44s%-10s%s", label, status, note)
	fmt.Println(color(line, statusColor(status)))
}

func statusColor(status Status) string {
	switch status {
	case StatusOK:
		return "green"
	case StatusAdded, StatusChanged:
		return "blue"
	case StatusMissing:
		return "yellow"
	default:
		return "red"
	}
}

func color(value string, colorName string) string {
	if os.Getenv("NO_COLOR") != "" {
		return value
	}
	codes := map[string]string{
		"green":  "38;2;52;211;153",
		"blue":   "38;2;96;165;250",
		"yellow": "38;2;245;158;11",
		"red":    "38;2;248;113;113",
	}
	return "\x1b[" + codes[colorName] + "m" + value + "\x1b[0m"
}
