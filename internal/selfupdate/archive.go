package selfupdate

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultMaximumArtifactBytes  int64 = 256 * 1024 * 1024
	defaultMaximumExtractedBytes int64 = 512 * 1024 * 1024
	maximumArchiveMembers              = 16
	artifactRequestTimeout             = 2 * time.Minute
)

type ArtifactCommandRunner func(
	context.Context,
	string,
	[]string,
	string,
	[]string,
	io.Writer,
	io.Writer,
) error

type ArtifactInstallerOptions struct {
	Client                *http.Client
	CommandRunner         ArtifactCommandRunner
	HomeDirectory         string
	MaximumArtifactBytes  int64
	MaximumExtractedBytes int64
	TemporaryDirectory    string
}

type managedArtifactInstaller struct {
	client                *http.Client
	commandRunner         ArtifactCommandRunner
	homeDirectory         string
	maximumArtifactBytes  int64
	maximumExtractedBytes int64
	temporaryDirectory    string
}

func NewManagedArtifactInstaller(options ArtifactInstallerOptions) ArtifactInstaller {
	client := options.Client
	if client == nil {
		client = http.DefaultClient
	}
	maximumArtifact := options.MaximumArtifactBytes
	if maximumArtifact < 1 {
		maximumArtifact = defaultMaximumArtifactBytes
	}
	maximumExtracted := options.MaximumExtractedBytes
	if maximumExtracted < 1 {
		maximumExtracted = defaultMaximumExtractedBytes
	}
	home := options.HomeDirectory
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	runner := options.CommandRunner
	if runner == nil {
		runner = runArtifactCommand
	}
	return &managedArtifactInstaller{
		client:                client,
		commandRunner:         runner,
		homeDirectory:         home,
		maximumArtifactBytes:  maximumArtifact,
		maximumExtractedBytes: maximumExtracted,
		temporaryDirectory:    options.TemporaryDirectory,
	}
}

func (installer *managedArtifactInstaller) Apply(
	ctx context.Context,
	installation Installation,
	release Release,
	stdout io.Writer,
	stderr io.Writer,
) (ApplyOutcome, error) {
	expectedAsset := fmt.Sprintf(
		"project-space-machine-tools-%s-v%s.tar.gz",
		release.Artifact.Target,
		release.Manifest.Version,
	)
	expectedURL := fmt.Sprintf(
		"https://github.com/DotNaos/project-space/releases/download/v%s/%s",
		release.Manifest.Version,
		expectedAsset,
	)
	if installation.Source != InstallSourceManaged ||
		(release.Artifact.Target != "darwin-arm64" && release.Artifact.Target != "linux-x64") ||
		installation.Target != release.Artifact.Target || !filepath.IsAbs(installation.InstallDir) ||
		release.Artifact.AssetName != expectedAsset || release.Manifest.ReleaseID != "v"+release.Manifest.Version ||
		release.Artifact.DownloadURL != expectedURL || !filepath.IsAbs(installer.homeDirectory) {
		return "", errors.New("managed artifact installer does not support this installation")
	}
	transactionRoot, err := os.MkdirTemp(installer.temporaryDirectory, "project-self-update-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(transactionRoot)
	if err := os.Chmod(transactionRoot, 0o700); err != nil {
		return "", err
	}

	archivePath, err := installer.download(ctx, release.Artifact, transactionRoot)
	if err != nil {
		return "", err
	}
	bundleRoot, err := installer.extract(
		archivePath,
		transactionRoot,
		release.Artifact.Target,
		release.Manifest.Version,
	)
	if err != nil {
		return "", err
	}
	environment := artifactEnvironment(installer.homeDirectory)
	err = installer.commandRunner(
		ctx,
		filepath.Join(bundleRoot, "install.sh"),
		[]string{"--install-dir", installation.InstallDir},
		bundleRoot,
		environment,
		stdout,
		stderr,
	)
	if err != nil {
		switch commandExitCode(err) {
		case 70:
			return ApplyOutcomeRolledBack, fmt.Errorf("machine-tools update was rolled back: %w", err)
		case 71:
			return ApplyOutcomeRecoveryRequired, fmt.Errorf("machine-tools update requires manual recovery: %w", err)
		default:
			return "", fmt.Errorf("machine-tools installer failed: %w", err)
		}
	}
	if err := installer.verifyInstalledVersions(
		ctx,
		installation,
		release.Manifest.Version,
		environment,
	); err != nil {
		// install.sh verifies the pair before committing. A later mismatch means
		// the installed files changed after that transaction and need recovery.
		return ApplyOutcomeRecoveryRequired, err
	}
	return ApplyOutcomeUpdated, nil
}

func (installer *managedArtifactInstaller) download(
	ctx context.Context,
	artifact Artifact,
	transactionRoot string,
) (string, error) {
	if artifact.SizeBytes < 1 || artifact.SizeBytes > installer.maximumArtifactBytes ||
		len(artifact.SHA256) != sha256.Size*2 {
		return "", errors.New("release artifact has invalid integrity bounds")
	}
	if _, err := hex.DecodeString(artifact.SHA256); err != nil || artifact.SHA256 != strings.ToLower(artifact.SHA256) {
		return "", errors.New("release artifact has an invalid SHA-256 digest")
	}
	parsed, err := url.Parse(artifact.DownloadURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() != "github.com" || parsed.Port() != "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || pathpkg.Base(parsed.Path) != artifact.AssetName {
		return "", errors.New("release artifact URL is not an exact HTTPS asset URL")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.DownloadURL, nil)
	if err != nil {
		return "", err
	}
	client := *installer.client
	if client.Timeout <= 0 {
		client.Timeout = artifactRequestTimeout
	}
	client.CheckRedirect = safeGitHubRedirect
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("download release artifact: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Request == nil || response.Request.URL == nil ||
		response.Request.URL.Scheme != "https" || !safeGitHubHost(response.Request.URL.Hostname()) {
		return "", errors.New("release artifact download did not return the exact approved asset")
	}
	if response.ContentLength >= 0 && response.ContentLength != artifact.SizeBytes {
		return "", errors.New("release artifact download size does not match the manifest")
	}
	file, err := os.OpenFile(
		filepath.Join(transactionRoot, "artifact.tar.gz"),
		os.O_CREATE|os.O_EXCL|os.O_WRONLY,
		0o600,
	)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, artifact.SizeBytes+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil {
		return "", errors.Join(copyErr, syncErr, closeErr)
	}
	if written != artifact.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return "", errors.New("release artifact failed its size or SHA-256 verification")
	}
	return filepath.Join(transactionRoot, "artifact.tar.gz"), nil
}

func (installer *managedArtifactInstaller) extract(
	archivePath, transactionRoot, target, version string,
) (string, error) {
	expectedAsset := fmt.Sprintf("project-space-machine-tools-%s-v%s", target, version)
	members, ok := archiveBundleMembers(target)
	if !ok {
		return "", errors.New("managed archive target is unsupported")
	}
	file, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return "", errors.New("release artifact is not a gzip archive")
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	seen := make(map[string]bool, len(members)+1)
	bundleRoot := filepath.Join(transactionRoot, expectedAsset)
	var extractedBytes int64
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			return "", errors.New("release artifact tar stream is invalid")
		}
		if len(seen) >= maximumArchiveMembers {
			return "", errors.New("release artifact contains too many members")
		}
		name, err := safeArchiveName(header.Name, expectedAsset)
		if err != nil {
			return "", err
		}
		if seen[name] {
			return "", errors.New("release artifact contains a duplicate member")
		}
		seen[name] = true
		if header.Linkname != "" {
			return "", errors.New("release artifact contains a link")
		}
		if name == expectedAsset {
			if header.Typeflag != tar.TypeDir {
				return "", errors.New("release artifact bundle root is not a directory")
			}
			if err := os.Mkdir(bundleRoot, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return "", err
			}
			continue
		}
		memberName := strings.TrimPrefix(name, expectedAsset+"/")
		mode, allowed := members[memberName]
		if !allowed || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA) {
			return "", errors.New("release artifact contains an unexpected member")
		}
		if header.Size < 0 || header.Size > installer.maximumExtractedBytes-extractedBytes {
			return "", errors.New("release artifact extracted size exceeds its limit")
		}
		extractedBytes += header.Size
		if !seen[expectedAsset] {
			return "", errors.New("release artifact file precedes its bundle root")
		}
		destination := filepath.Join(bundleRoot, memberName)
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return "", err
		}
		written, copyErr := io.CopyN(output, reader, header.Size)
		syncErr := output.Sync()
		closeErr := output.Close()
		if copyErr != nil || written != header.Size || syncErr != nil || closeErr != nil {
			return "", errors.Join(copyErr, syncErr, closeErr)
		}
	}
	if len(seen) != len(members)+1 || !seen[expectedAsset] {
		return "", errors.New("release artifact bundle is incomplete")
	}
	for name := range members {
		if !seen[expectedAsset+"/"+name] {
			return "", errors.New("release artifact bundle is incomplete")
		}
	}
	versionBody, err := os.ReadFile(filepath.Join(bundleRoot, "VERSION"))
	if err != nil || string(versionBody) != version+"\n" {
		return "", errors.New("release artifact version does not match the approved release")
	}
	if err := verifyBundleChecksums(bundleRoot, members); err != nil {
		return "", err
	}
	return bundleRoot, nil
}

func archiveBundleMembers(target string) (map[string]fs.FileMode, bool) {
	members := map[string]fs.FileMode{
		"CODEX-LICENSE": 0o600,
		"CODEX-NOTICE":  0o600,
		"CODEX-VERSION": 0o600,
		"SHA256SUMS.txt": 0o600,
		"VERSION":        0o600,
		"codex":          0o700,
		"install.sh":              0o700,
		"project":                 0o700,
		"project-codex-host":      0o700,
		"release-manifest-signing-public-key.pem": 0o600,
	}
	switch target {
	case "darwin-arm64":
	case "linux-x64":
	default:
		return nil, false
	}
	return members, true
}

func safeArchiveName(name, expectedRoot string) (string, error) {
	if name == "" || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") ||
		strings.ContainsRune(name, '\x00') {
		return "", errors.New("release artifact contains an unsafe path")
	}
	normalized := strings.TrimSuffix(name, "/")
	if pathpkg.Clean(normalized) != normalized ||
		(normalized != expectedRoot && !strings.HasPrefix(normalized, expectedRoot+"/")) {
		return "", errors.New("release artifact contains an unsafe path")
	}
	for _, component := range strings.Split(normalized, "/") {
		if component == "" || component == "." || component == ".." {
			return "", errors.New("release artifact contains an unsafe path")
		}
	}
	return normalized, nil
}

func verifyBundleChecksums(bundleRoot string, members map[string]fs.FileMode) error {
	checksum, err := os.Open(filepath.Join(bundleRoot, "SHA256SUMS.txt"))
	if err != nil {
		return err
	}
	defer checksum.Close()
	expected := make(map[string]string, len(members)-1)
	scanner := bufio.NewScanner(io.LimitReader(checksum, 64*1024))
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 67 || line[64:66] != "  " {
			return errors.New("release artifact checksum file is invalid")
		}
		digest := line[:64]
		if decoded, decodeErr := hex.DecodeString(digest); decodeErr != nil || len(decoded) != sha256.Size || digest != strings.ToLower(digest) {
			return errors.New("release artifact checksum digest is invalid")
		}
		name := line[66:]
		if _, allowed := members[name]; !allowed || name == "SHA256SUMS.txt" || expected[name] != "" {
			return errors.New("release artifact checksum member is invalid")
		}
		expected[name] = digest
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(expected) != len(members)-1 {
		return errors.New("release artifact checksum file is incomplete")
	}
	for name, digest := range expected {
		file, err := os.Open(filepath.Join(bundleRoot, name))
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			return errors.Join(copyErr, closeErr)
		}
		if hex.EncodeToString(hash.Sum(nil)) != digest {
			return errors.New("release artifact member failed its checksum")
		}
	}
	return nil
}

func (installer *managedArtifactInstaller) verifyInstalledVersions(
	ctx context.Context,
	installation Installation,
	version string,
	environment []string,
) error {
	for _, name := range []string{"project", "project-codex-host"} {
		output := &bytes.Buffer{}
		if err := installer.commandRunner(
			ctx,
			filepath.Join(installation.InstallDir, name),
			[]string{"--version"},
			installation.InstallDir,
			environment,
			output,
			output,
		); err != nil || !versionOutputMatches(output.String(), version) {
			return fmt.Errorf("installed %s version could not be verified; manual recovery is required", name)
		}
	}
	return nil
}

func versionOutputMatches(output, version string) bool {
	for _, field := range strings.Fields(output) {
		if field == version || strings.TrimPrefix(field, "v") == version {
			return true
		}
	}
	return false
}

func artifactEnvironment(homeDirectory string) []string {
	pathEntries := []string{"/usr/bin", "/bin"}
	// WSL manages its connector through Windows PowerShell. Preserve only that
	// executable's directory instead of forwarding the caller's complete PATH.
	if powershell, err := exec.LookPath("powershell.exe"); err == nil {
		if absolute, absoluteErr := filepath.Abs(powershell); absoluteErr == nil {
			if info, statErr := os.Stat(absolute); statErr == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
				directory := filepath.Dir(absolute)
				if directory != pathEntries[0] && directory != pathEntries[1] {
					pathEntries = append(pathEntries, directory)
				}
			}
		}
	}
	return []string{
		"HOME=" + homeDirectory,
		"LC_ALL=C",
		"PATH=" + strings.Join(pathEntries, string(os.PathListSeparator)),
	}
}

func runArtifactCommand(
	ctx context.Context,
	command string,
	arguments []string,
	directory string,
	environment []string,
	stdout io.Writer,
	stderr io.Writer,
) error {
	process := exec.CommandContext(ctx, command, arguments...)
	process.Dir = directory
	process.Env = environment
	process.Stdout = stdout
	process.Stderr = stderr
	return process.Run()
}

func commandExitCode(err error) int {
	var exitError interface{ ExitCode() int }
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}

var _ ArtifactInstaller = (*managedArtifactInstaller)(nil)
