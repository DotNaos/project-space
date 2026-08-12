package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/selfupdate"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

const (
	projectUpdateNoticeSchema            = 1
	projectUpdateNoticeCacheFile         = "update-notice.json"
	projectUpdateNoticeRefreshMarker     = ".update-notice-refresh"
	projectUpdateNoticeOptOutEnvironment = "PROJECT_CLI_NO_UPDATE_CHECK"
	projectUpdateNoticeMaximumBytes      = 4096
	projectUpdateNoticeRefreshInterval   = 24 * time.Hour
	projectUpdateNoticeFailureRetry      = 15 * time.Minute
	projectUpdateNoticeMarkerLifetime    = 2 * time.Minute
)

type projectUpdateNoticeRecord struct {
	SchemaVersion  int              `json:"schemaVersion"`
	CheckedAt      time.Time        `json:"checkedAt"`
	CurrentVersion string           `json:"currentVersion"`
	TargetVersion  string           `json:"targetVersion,omitempty"`
	State          selfupdate.State `json:"state"`
}

type projectUpdateNoticeCache struct {
	Directory string
	Now       func() time.Time
}

type projectUpdateNoticeDependencies struct {
	CacheDirectory func() string
	CurrentVersion func() string
	Environment    func(string) string
	Now            func() time.Time
	StartRefresh   func() error
}

type projectUpdateNoticeRefreshDependencies struct {
	CacheDirectory func() string
	CurrentVersion func() string
	LoadService    func() (selfUpdateService, error)
	Now            func() time.Time
}

func defaultProjectUpdateNoticeDependencies() projectUpdateNoticeDependencies {
	return projectUpdateNoticeDependencies{
		CacheDirectory: projectCatalogCacheDirectory,
		CurrentVersion: func() string { return projectMachineClientVersion },
		Environment:    os.Getenv,
		Now:            time.Now,
		StartRefresh:   startProjectUpdateNoticeRefresh,
	}
}

func maybeShowProjectUpdateNotice(
	ctx context.Context,
	arguments []string,
	stdout *os.File,
	stderr *os.File,
) {
	if ctx.Err() != nil || stdout == nil || stderr == nil ||
		!term.IsTerminal(int(stdout.Fd())) || !term.IsTerminal(int(stderr.Fd())) {
		return
	}
	_ = runProjectUpdateNotice(
		arguments,
		stderr,
		defaultProjectUpdateNoticeDependencies(),
	)
}

func runProjectUpdateNotice(
	arguments []string,
	output io.Writer,
	dependencies projectUpdateNoticeDependencies,
) error {
	if output == nil || dependencies.CacheDirectory == nil ||
		dependencies.CurrentVersion == nil || dependencies.Environment == nil ||
		dependencies.Now == nil || dependencies.StartRefresh == nil ||
		!projectUpdateNoticeEligible(arguments) ||
		projectUpdateNoticeOptedOut(dependencies.Environment(
			projectUpdateNoticeOptOutEnvironment,
		)) {
		return nil
	}
	currentVersion := dependencies.CurrentVersion()
	if !projectUpdateNoticeVersionValid(currentVersion) {
		return nil
	}
	cache := projectUpdateNoticeCache{
		Directory: dependencies.CacheDirectory(),
		Now:       dependencies.Now,
	}
	record, fresh := cache.Read(currentVersion)
	if fresh {
		if record.State == selfupdate.StateUpdateAvailable {
			_, err := fmt.Fprintf(
				output,
				"Project %s is available (current: %s). Run `project self-update` to install it.\n",
				record.TargetVersion,
				record.CurrentVersion,
			)
			return err
		}
		return nil
	}
	started, err := cache.BeginRefresh()
	if err != nil || !started {
		return nil
	}
	if err := dependencies.StartRefresh(); err != nil {
		_ = cache.EndRefresh()
	}
	return nil
}

func projectUpdateNoticeEligible(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--help" || argument == "-h" {
			return false
		}
	}
	for _, argument := range arguments {
		if strings.HasPrefix(argument, "-") {
			continue
		}
		return argument != "self-update" && argument != "completion" &&
			argument != "help" && !strings.HasPrefix(argument, "__")
	}
	return true
}

func projectUpdateNoticeOptedOut(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false", "no":
		return false
	default:
		return true
	}
}

func (cache projectUpdateNoticeCache) Read(
	currentVersion string,
) (projectUpdateNoticeRecord, bool) {
	var record projectUpdateNoticeRecord
	if cache.Directory == "" || !projectUpdateNoticeVersionValid(currentVersion) {
		return record, false
	}
	path := filepath.Join(cache.Directory, projectUpdateNoticeCacheFile)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 ||
		info.Size() < 1 || info.Size() > projectUpdateNoticeMaximumBytes {
		return record, false
	}
	file, err := os.Open(path)
	if err != nil {
		return record, false
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, projectUpdateNoticeMaximumBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&record); err != nil {
		return projectUpdateNoticeRecord{}, false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || !record.validFor(currentVersion) {
		return projectUpdateNoticeRecord{}, false
	}
	maximumAge := projectUpdateNoticeRefreshInterval
	if record.State == selfupdate.StateVerificationFailed {
		maximumAge = projectUpdateNoticeFailureRetry
	}
	age := cache.now().Sub(record.CheckedAt)
	return record, age >= 0 && age <= maximumAge
}

func (cache projectUpdateNoticeCache) Write(record projectUpdateNoticeRecord) error {
	if cache.Directory == "" || !record.validFor(record.CurrentVersion) {
		return errors.New("Project update notice cache record is invalid")
	}
	if err := ensurePrivateProjectUpdateNoticeDirectory(cache.Directory); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(cache.Directory, ".update-notice-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	encoder := json.NewEncoder(temporary)
	if err := encoder.Encode(record); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(
		temporaryPath,
		filepath.Join(cache.Directory, projectUpdateNoticeCacheFile),
	)
}

func (cache projectUpdateNoticeCache) BeginRefresh() (bool, error) {
	if cache.Directory == "" {
		return false, nil
	}
	if err := ensurePrivateProjectUpdateNoticeDirectory(cache.Directory); err != nil {
		return false, err
	}
	path := filepath.Join(cache.Directory, projectUpdateNoticeRefreshMarker)
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			body := strconv.FormatInt(cache.now().Unix(), 10) + "\n"
			writeErr := errors.Join(writeAll(file, []byte(body)), file.Sync(), file.Close())
			if writeErr != nil {
				_ = os.Remove(path)
				return false, writeErr
			}
			return true, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return false, err
		}
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.Mode().IsRegular() ||
			cache.now().Sub(info.ModTime()) < projectUpdateNoticeMarkerLifetime {
			return false, nil
		}
		if err := os.Remove(path); err != nil {
			return false, nil
		}
		cache.removeTemporaryFiles()
	}
	return false, nil
}

func (cache projectUpdateNoticeCache) EndRefresh() error {
	err := os.Remove(filepath.Join(cache.Directory, projectUpdateNoticeRefreshMarker))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (cache projectUpdateNoticeCache) removeTemporaryFiles() {
	matches, err := filepath.Glob(filepath.Join(cache.Directory, ".update-notice-*.tmp"))
	if err != nil {
		return
	}
	for _, match := range matches {
		info, statErr := os.Lstat(match)
		if statErr == nil && info.Mode().IsRegular() {
			_ = os.Remove(match)
		}
	}
}

func (cache projectUpdateNoticeCache) now() time.Time {
	if cache.Now != nil {
		return cache.Now().UTC()
	}
	return time.Now().UTC()
}

func (record projectUpdateNoticeRecord) validFor(currentVersion string) bool {
	if record.SchemaVersion != projectUpdateNoticeSchema || record.CheckedAt.IsZero() ||
		record.CurrentVersion != currentVersion ||
		!projectUpdateNoticeVersionValid(record.CurrentVersion) {
		return false
	}
	switch record.State {
	case selfupdate.StateCurrent:
		return record.TargetVersion == record.CurrentVersion
	case selfupdate.StateUpdateAvailable:
		return projectUpdateNoticeVersionNewer(
			record.CurrentVersion,
			record.TargetVersion,
		)
	case selfupdate.StateUnsupportedSource, selfupdate.StateVerificationFailed:
		return record.TargetVersion == "" ||
			projectUpdateNoticeVersionValid(record.TargetVersion)
	default:
		return false
	}
}

func projectUpdateNoticeVersionValid(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return false
		}
		if _, err := strconv.ParseUint(part, 10, 64); err != nil {
			return false
		}
	}
	return true
}

func projectUpdateNoticeVersionNewer(current, target string) bool {
	if !projectUpdateNoticeVersionValid(current) ||
		!projectUpdateNoticeVersionValid(target) {
		return false
	}
	currentParts := strings.Split(current, ".")
	targetParts := strings.Split(target, ".")
	for index := range currentParts {
		left, _ := strconv.ParseUint(currentParts[index], 10, 64)
		right, _ := strconv.ParseUint(targetParts[index], 10, 64)
		if right != left {
			return right > left
		}
	}
	return false
}

func ensurePrivateProjectUpdateNoticeDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return errors.New("Project CLI cache directory is unsafe")
	}
	return os.Chmod(directory, 0o700)
}

func writeAll(writer io.Writer, body []byte) error {
	for len(body) > 0 {
		written, err := writer.Write(body)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		body = body[written:]
	}
	return nil
}

func startProjectUpdateNoticeRefresh() error {
	command := exec.Command(os.Args[0], projectUpdateNoticeRefreshCommand)
	command.Env = os.Environ()
	configureProjectUpdateNoticeRefreshProcess(command)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

const projectUpdateNoticeRefreshCommand = "__update-notice-refresh"

func newUpdateNoticeRefreshCommand() *cobra.Command {
	command := &cobra.Command{
		Use:    projectUpdateNoticeRefreshCommand,
		Hidden: true,
		Args:   cobra.NoArgs,
		Run: func(command *cobra.Command, _ []string) {
			_ = refreshProjectUpdateNotice(command.Context())
		},
	}
	return command
}

func refreshProjectUpdateNotice(ctx context.Context) error {
	return refreshProjectUpdateNoticeWithDependencies(
		ctx,
		projectUpdateNoticeRefreshDependencies{
			CacheDirectory: projectCatalogCacheDirectory,
			CurrentVersion: func() string { return projectMachineClientVersion },
			LoadService:    defaultSelfUpdateService,
			Now:            time.Now,
		},
	)
}

func refreshProjectUpdateNoticeWithDependencies(
	ctx context.Context,
	dependencies projectUpdateNoticeRefreshDependencies,
) error {
	if dependencies.CacheDirectory == nil || dependencies.CurrentVersion == nil ||
		dependencies.LoadService == nil || dependencies.Now == nil {
		return errors.New("Project update notice dependencies are incomplete")
	}
	cache := projectUpdateNoticeCache{
		Directory: dependencies.CacheDirectory(),
		Now:       dependencies.Now,
	}
	defer cache.EndRefresh()
	currentVersion := dependencies.CurrentVersion()
	service, err := dependencies.LoadService()
	if err != nil {
		return writeProjectUpdateNoticeFailure(cache, currentVersion)
	}
	plan, planErr := service.Plan(ctx)
	state := plan.Result.State
	if planErr != nil {
		state = selfupdate.StateVerificationFailed
	}
	record := projectUpdateNoticeRecord{
		SchemaVersion:  projectUpdateNoticeSchema,
		CheckedAt:      cache.now(),
		CurrentVersion: plan.Result.CurrentVersion,
		TargetVersion:  plan.Result.TargetVersion,
		State:          state,
	}
	if !record.validFor(currentVersion) {
		return writeProjectUpdateNoticeFailure(cache, currentVersion)
	}
	return cache.Write(record)
}

func writeProjectUpdateNoticeFailure(
	cache projectUpdateNoticeCache,
	currentVersion string,
) error {
	record := projectUpdateNoticeRecord{
		SchemaVersion:  projectUpdateNoticeSchema,
		CheckedAt:      cache.now(),
		CurrentVersion: currentVersion,
		State:          selfupdate.StateVerificationFailed,
	}
	if !record.validFor(record.CurrentVersion) {
		return nil
	}
	return cache.Write(record)
}
