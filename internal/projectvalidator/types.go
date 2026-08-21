package projectvalidator

type TemplateLock struct {
	Template        string           `json:"template" yaml:"template"`
	Version         string           `json:"version" yaml:"version"`
	Commit          string           `json:"commit,omitempty" yaml:"commit,omitempty"`
	Checksum        string           `json:"checksum,omitempty" yaml:"checksum,omitempty"`
	ChecksumVersion int              `json:"checksumVersion,omitempty" yaml:"checksumVersion,omitempty"`
	TemplatePath    string           `json:"templatePath,omitempty" yaml:"templatePath,omitempty"`
	Modules         []string         `json:"modules,omitempty" yaml:"modules,omitempty"`
	Waivers         []AdoptionWaiver `json:"waivers,omitempty" yaml:"waivers,omitempty"`
}

type TemplateSpec struct {
	Root           string
	Name           string
	Version        string
	Files          map[string]TemplateFileSpec
	TemplateFiles  map[string]bool
	Slots          []SlotRule
	Modules        map[string]TemplateModuleSpec
	ModuleOwnRules map[string][]ownRule
	SelfValues     map[string]string
}

type TemplateFileSpec struct {
	Path         string `yaml:"-"`
	TemplatePath string `yaml:"template"`
	SlotsPath    string `yaml:"slots"`
}

type TemplateModuleSpec struct {
	Name         string                       `yaml:"name"`
	Description  string                       `yaml:"description"`
	Default      bool                         `yaml:"default"`
	DependsOn    []string                     `yaml:"dependsOn"`
	MigratesFrom []string                     `yaml:"migratesFrom"`
	Values       map[string]TemplateValueSpec `yaml:"values"`
	Rules        map[string]TemplateFileRules `yaml:"rules"`
	Blockers     []TemplateBlockerRule        `yaml:"blockers"`
	Owns         []string                     `yaml:"owns"`
	AppTarget    *TemplateAppTargetSpec       `yaml:"appTarget"`
}

type TemplateAppTargetSpec struct {
	ID            string            `yaml:"id"`
	Devices       []string          `yaml:"devices"`
	SharedModule  string            `yaml:"sharedModule"`
	SharedDevices []string          `yaml:"sharedDevices"`
	DeviceModules map[string]string `yaml:"deviceModules"`
}

type AppTargetSelection struct {
	Target  string
	Devices []string
}

type TemplateValueSpec struct {
	Type        string `yaml:"type"`
	Required    bool   `yaml:"required"`
	Description string `yaml:"description"`
	Pattern     string `yaml:"pattern"`
	Default     string `yaml:"default"`
	DefaultFrom string `yaml:"defaultFrom"`
	Transform   string `yaml:"transform"`
}

type TemplateFileRules struct {
	Format  string                  `yaml:"format"`
	Entries []TemplateFileRuleEntry `yaml:"entries"`
}

type TemplateFileRuleEntry struct {
	Path    string `yaml:"path"`
	Kind    string `yaml:"kind"`
	Pattern string `yaml:"pattern"`
}

type TemplateBlockerRule struct {
	Path   string `yaml:"path"`
	Reason string `yaml:"reason"`
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
	Values      map[string]TemplateValueSpec
	Owns        []string
	Files       []string
}

type Status string

const (
	StatusOK        Status = "OK"
	StatusAdded     Status = "ADDED"
	StatusMissing   Status = "MISSING"
	StatusChanged   Status = "CHANGED"
	StatusWaived    Status = "WAIVED"
	StatusViolation Status = "VIOLATION"
)

type StructureEntry struct {
	Path   string
	Kind   string
	Status Status
	Code   string
	Note   string
	Slot   string
	Module string
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
	Module      string
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

type AdoptionPlan struct {
	ProjectRoot   string                  `json:"projectRoot"`
	ProjectName   string                  `json:"projectName"`
	TemplateLabel string                  `json:"templateLabel"`
	WouldWrite    bool                    `json:"wouldWrite"`
	Summary       AdoptionCounts          `json:"summary"`
	Modules       []ModuleAdoptionSummary `json:"modules"`
	Files         []AdoptionFile          `json:"files"`
}

type ModuleAdoptionSummary struct {
	Name      string         `json:"name"`
	Adopted   bool           `json:"adopted"`
	Summary   AdoptionCounts `json:"summary"`
	Owns      []string       `json:"owns"`
	DependsOn []string       `json:"dependsOn"`
}

type AdoptionFile struct {
	Path   string `json:"path"`
	State  string `json:"state"`
	Module string `json:"module,omitempty"`
	Slot   string `json:"slot,omitempty"`
	Note   string `json:"note,omitempty"`
}

type AdoptionWaiver struct {
	Path   string `json:"path" yaml:"path"`
	Reason string `json:"reason" yaml:"reason"`
	Added  string `json:"added" yaml:"added"`
}

type AdoptionWaiverOptions struct {
	Apply bool
	Today string
}

type AdoptionWaiverPlan struct {
	ProjectRoot   string `json:"projectRoot"`
	Path          string `json:"path"`
	Reason        string `json:"reason"`
	Added         string `json:"added"`
	AlreadyExists bool   `json:"alreadyExists"`
	WouldWrite    bool   `json:"wouldWrite"`
	LockPath      string `json:"lockPath,omitempty"`
}

type AdoptionModuleOptions struct {
	Apply  bool
	DryRun bool
}

type AdoptionModulePlan struct {
	ProjectRoot    string               `json:"projectRoot"`
	Module         string               `json:"module"`
	AlreadyAdopted []string             `json:"alreadyAdopted"`
	ToAdopt        []string             `json:"toAdopt"`
	Files          []AdoptionModuleFile `json:"files"`
	WouldWrite     bool                 `json:"wouldWrite"`
	LockPath       string               `json:"lockPath,omitempty"`
}

type AdoptionModuleFile struct {
	Action string `json:"action"`
	Module string `json:"module"`
	Path   string `json:"path"`
}

type AdoptionCounts struct {
	Match   int `json:"match"`
	Slot    int `json:"slot"`
	Blocker int `json:"blocker"`
	Waived  int `json:"waived"`
	Missing int `json:"missing"`
	Drift   int `json:"drift"`
	Unknown int `json:"unknown"`
}

type ViolationQuarantineOptions struct {
	Apply  bool
	DryRun bool
}

type ViolationQuarantinePlan struct {
	ProjectRoot    string
	QuarantineRoot string
	Files          []ViolationQuarantineFile
	WouldWrite     bool
	ManifestPath   string
}

type ViolationQuarantineFile struct {
	Action         string
	OriginalPath   string
	QuarantinePath string
	Code           string
	Module         string
}

type TemplateUpdateOptions struct {
	TemplatePath string
	DryRun       bool
	Targets      []AppTargetSelection
}

type TemplateUpdatePlan struct {
	ProjectRoot    string
	SourceRoot     string
	SourceCommit   string
	FromTemplate   string
	FromVersion    string
	FromCommit     string
	FromChecksum   string
	ToTemplate     string
	ToVersion      string
	ToChecksum     string
	FromModules    []string
	ToModules      []string
	Values         []TemplateUpdateValueChange
	Files          []TemplateUpdateFileChange
	WouldWrite     bool
	ConflictFolder string
}

type TemplateUpdateValueChange struct {
	Action string
	Key    string
	Before string
	After  string
}

type TemplateUpdateFileChange struct {
	Action string
	Path   string
	Result string
	Module string
}
