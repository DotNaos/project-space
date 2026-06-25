package projectvalidator

type TemplateLock struct {
	Template     string   `json:"template" yaml:"template"`
	Version      string   `json:"version" yaml:"version"`
	Commit       string   `json:"commit,omitempty" yaml:"commit,omitempty"`
	Checksum     string   `json:"checksum,omitempty" yaml:"checksum,omitempty"`
	TemplatePath string   `json:"templatePath,omitempty" yaml:"templatePath,omitempty"`
	Modules      []string `json:"modules,omitempty" yaml:"modules,omitempty"`
}

type TemplateSpec struct {
	Root               string
	Name               string
	Version            string
	StructurePath      string
	StructureSlotsPath string
	Files              map[string]TemplateFileSpec
	TreeMode           bool
	TemplateFiles      map[string]bool
	Slots              []SlotRule
	Modules            map[string]TemplateModuleSpec
}

type TemplateFileSpec struct {
	Path         string `yaml:"-"`
	TemplatePath string `yaml:"template"`
	SlotsPath    string `yaml:"slots"`
}

type TemplateModuleSpec struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Default     bool     `yaml:"default"`
	DependsOn   []string `yaml:"dependsOn"`
	Owns        []string `yaml:"owns"`
}

type ModuleInstallOptions struct {
	Apply  bool
	Force  bool
	DryRun bool
}

type ModuleRemoveOptions struct {
	Apply  bool
	DryRun bool
}

type ModuleInstallPlan struct {
	ProjectRoot      string
	Module           string
	AlreadyInstalled []string
	ToInstall        []string
	Files            []ModuleInstallFile
	Conflicts        []ModuleInstallConflict
	WouldWrite       bool
	LockPath         string
}

type ModuleRemovePlan struct {
	ProjectRoot string
	Module      string
	ToRemove    []string
	Files       []ModuleInstallFile
	BlockedBy   []string
	WouldWrite  bool
	LockPath    string
}

type ModuleInstallFile struct {
	Action string
	Module string
	Path   string
}

type ModuleInstallConflict struct {
	Module string
	Path   string
}

type ModuleInfo struct {
	Name        string
	Description string
	Installed   bool
	Default     bool
	DependsOn   []string
	Owns        []string
	Files       []string
}

type Status string

const (
	StatusOK        Status = "OK"
	StatusAdded     Status = "ADDED"
	StatusMissing   Status = "MISSING"
	StatusChanged   Status = "CHANGED"
	StatusViolation Status = "VIOLATION"
)

type StructureEntry struct {
	Path   string
	Kind   string
	Status Status
	Code   string
	Note   string
	Slot   string
}

type FileDiagnostic struct {
	Path   string
	Status Status
	Note   string
}

type FileValidation struct {
	Path        string
	Status      Status
	Code        string
	Note        string
	Diagnostics []FileDiagnostic
}

type Report struct {
	ProjectRoot   string
	ProjectName   string
	TemplateLabel string
	Structure     []StructureEntry
	Files         []FileValidation
	OK            bool
}
