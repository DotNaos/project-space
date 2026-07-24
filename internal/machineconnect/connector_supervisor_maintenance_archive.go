package machineconnect

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"
)

func (maintenance *ConnectorSupervisorMaintenance) verifyAndOpenArtifact(
	artifact connectorSupervisorControlArtifact,
) (*os.File, error) {
	info, err := os.Lstat(artifact.Path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		info.Mode().Perm()&0o077 != 0 || info.Size() != artifact.SizeBytes ||
		info.Size() < 1 || info.Size() > maintenance.maximumArtifact {
		return nil, errors.New("staged artifact file is unsafe")
	}
	file, err := os.Open(artifact.Path)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		_ = file.Close()
		return nil, errors.New("staged artifact changed while opening")
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, maintenance.maximumArtifact+1))
	if err != nil || written != artifact.SizeBytes ||
		hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		_ = file.Close()
		return nil, errors.New("staged artifact integrity check failed")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

func (maintenance *ConnectorSupervisorMaintenance) installArchive(
	request connectorSupervisorControlRequest,
	archive *os.File,
) (string, error) {
	if request.Target != "darwin-arm64" && request.Target != "linux-x64" {
		return "", errors.New("managed archive update is unsupported for this target")
	}
	transactionRoot, err := os.MkdirTemp(maintenance.paths.VersionsRoot, ".maintenance-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(transactionRoot)
	if err := os.Chmod(transactionRoot, 0o700); err != nil {
		return "", err
	}
	bundleName := fmt.Sprintf(
		"project-space-machine-tools-%s-v%s",
		request.Target,
		request.Version,
	)
	bundleRoot := filepath.Join(transactionRoot, bundleName)
	extracted, err := maintenance.extractArchive(archive, transactionRoot, bundleName)
	if err != nil {
		return "", err
	}
	if err := verifyConnectorSupervisorBundle(
		bundleRoot,
		request.Target,
		request.Version,
		extracted,
	); err != nil {
		return "", err
	}
	releaseDirectoryName := request.Version + "-" + request.Artifact.SHA256[:16]
	if !managedPointerComponentPattern.MatchString(releaseDirectoryName) {
		return "", errors.New("managed release directory name is invalid")
	}
	destination := filepath.Join(maintenance.paths.VersionsRoot, releaseDirectoryName)
	if existing, err := os.Lstat(destination); err == nil {
		if existing.Mode()&fs.ModeSymlink != 0 || !existing.IsDir() {
			return "", errors.New("managed release path is unsafe")
		}
		if err := equalConnectorSupervisorBundles(bundleRoot, destination, extracted); err != nil {
			return "", err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	} else if err := os.Rename(bundleRoot, destination); err != nil {
		return "", err
	}
	if err := syncConnectorSupervisorDirectory(maintenance.paths.VersionsRoot); err != nil {
		return "", err
	}
	return filepath.ToSlash(filepath.Join(
		connectorSupervisorVersionsDirectoryName,
		releaseDirectoryName,
	)), nil
}

func (maintenance *ConnectorSupervisorMaintenance) extractArchive(
	archive *os.File,
	transactionRoot string,
	bundleName string,
) (map[string]fs.FileMode, error) {
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		return nil, errors.New("managed artifact is not a gzip archive")
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	seen := map[string]fs.FileMode{}
	var total int64
	memberCount := 0
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, errors.New("managed artifact archive is invalid")
		}
		memberCount++
		if memberCount > maximumConnectorSupervisorArchiveMembers {
			return nil, errors.New("managed artifact contains too many archive members")
		}
		name, err := safeConnectorSupervisorArchiveName(header.Name, bundleName)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[name]; duplicate {
			return nil, errors.New("managed artifact contains a duplicate archive member")
		}
		if header.Linkname != "" {
			return nil, errors.New("managed artifact contains a link")
		}
		destination := filepath.Join(transactionRoot, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if name != bundleName {
				return nil, errors.New("managed artifact contains an unexpected directory")
			}
			if err := os.Mkdir(destination, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return nil, err
			}
			seen[name] = fs.ModeDir | 0o700
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > maintenance.maximumExtracted-total {
				return nil, errors.New("managed artifact extracted size is too large")
			}
			total += header.Size
			if err := os.Mkdir(bundleRootPath(transactionRoot, bundleName), 0o700); err != nil &&
				!errors.Is(err, fs.ErrExist) {
				return nil, err
			}
			mode, ok := connectorSupervisorBundleMemberMode(
				strings.TrimPrefix(name, bundleName+"/"),
				maintenance.target,
			)
			if !ok {
				return nil, errors.New("managed artifact contains an unexpected file")
			}
			file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return nil, err
			}
			written, copyErr := io.CopyN(file, reader, header.Size)
			syncErr := file.Sync()
			closeErr := file.Close()
			if copyErr != nil || written != header.Size || syncErr != nil || closeErr != nil {
				return nil, errors.Join(copyErr, syncErr, closeErr)
			}
			seen[name] = mode
		default:
			return nil, errors.New("managed artifact contains an unsupported archive member")
		}
	}
	return seen, nil
}

func bundleRootPath(transactionRoot, bundleName string) string {
	return filepath.Join(transactionRoot, bundleName)
}

func safeConnectorSupervisorArchiveName(name, bundleName string) (string, error) {
	if name == "" || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") ||
		strings.ContainsRune(name, '\x00') {
		return "", errors.New("managed artifact contains an unsafe archive path")
	}
	normalized := strings.TrimSuffix(name, "/")
	if normalized == "" || pathpkg.Clean(normalized) != normalized ||
		(normalized != bundleName && !strings.HasPrefix(normalized, bundleName+"/")) {
		return "", errors.New("managed artifact contains an unsafe archive path")
	}
	for _, component := range strings.Split(normalized, "/") {
		if component == "" || component == "." || component == ".." {
			return "", errors.New("managed artifact contains an unsafe archive path")
		}
	}
	return normalized, nil
}

func connectorSupervisorBundleMembers(target string) map[string]fs.FileMode {
	members := map[string]fs.FileMode{
		"project":                             0o700,
		"project-space-connector":             0o700,
		"install.sh":                          0o700,
		"VERSION":                             0o600,
		"SHA256SUMS.txt":                      0o600,
		connectorSupervisorCommandKeyFileName: 0o600,
		connectorSupervisorReleaseKeyFileName: 0o600,
	}
	if target == "darwin-arm64" {
		members["project-approval-signer"] = 0o700
	}
	if target == "linux-x64" {
		members["codex"] = 0o700
		members["CODEX-LICENSE"] = 0o600
		members["CODEX-VERSION"] = 0o600
	}
	return members
}

func connectorSupervisorBundleMemberMode(name, target string) (fs.FileMode, bool) {
	mode, found := connectorSupervisorBundleMembers(target)[name]
	return mode, found
}

func verifyConnectorSupervisorBundle(
	bundleRoot, target, version string,
	extracted map[string]fs.FileMode,
) error {
	members := connectorSupervisorBundleMembers(target)
	if target == "linux-x64" {
		optional := []string{"codex", "CODEX-LICENSE", "CODEX-VERSION"}
		present := 0
		for _, name := range optional {
			if _, ok := extracted[filepath.Base(bundleRoot)+"/"+name]; ok {
				present++
			}
		}
		if present != 0 && present != len(optional) {
			return errors.New("managed artifact Codex runtime is incomplete")
		}
		if present == 0 {
			for _, name := range optional {
				delete(members, name)
			}
		}
	}
	if len(extracted) != len(members)+1 {
		return errors.New("managed artifact bundle is incomplete")
	}
	for name, mode := range members {
		archiveName := filepath.Base(bundleRoot) + "/" + name
		if extracted[archiveName] != mode {
			return errors.New("managed artifact bundle is incomplete")
		}
		info, err := os.Lstat(filepath.Join(bundleRoot, name))
		if err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
			info.Mode().Perm() != mode.Perm() {
			return errors.New("managed artifact bundle member is unsafe")
		}
	}
	versionBody, err := os.ReadFile(filepath.Join(bundleRoot, "VERSION"))
	if err != nil || string(versionBody) != version+"\n" {
		return errors.New("managed artifact version does not match the release")
	}
	if err := verifyConnectorSupervisorBundleChecksums(bundleRoot, members); err != nil {
		return err
	}
	commandKey, err := readConnectorSupervisorPublicKey(filepath.Join(
		bundleRoot,
		connectorSupervisorCommandKeyFileName,
	))
	if err != nil {
		return errors.New("managed artifact command verification key is invalid")
	}
	releaseKey, err := readConnectorSupervisorPublicKey(filepath.Join(
		bundleRoot,
		connectorSupervisorReleaseKeyFileName,
	))
	if err != nil || bytes.Equal(commandKey, releaseKey) {
		return errors.New("managed artifact release verification key is invalid")
	}
	return nil
}

func verifyConnectorSupervisorBundleChecksums(
	bundleRoot string,
	members map[string]fs.FileMode,
) error {
	file, err := os.Open(filepath.Join(bundleRoot, "SHA256SUMS.txt"))
	if err != nil {
		return err
	}
	defer file.Close()
	expected := make(map[string]string, len(members)-1)
	scanner := bufio.NewScanner(io.LimitReader(file, 64*1024))
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 67 || line[64:66] != "  " ||
			!connectorSupervisorDigestPattern.MatchString(line[:64]) {
			return errors.New("managed artifact checksum file is invalid")
		}
		name := line[66:]
		if _, allowed := members[name]; !allowed || name == "SHA256SUMS.txt" {
			return errors.New("managed artifact checksum member is invalid")
		}
		if _, duplicate := expected[name]; duplicate {
			return errors.New("managed artifact checksum member is duplicated")
		}
		expected[name] = line[:64]
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(expected) != len(members)-1 {
		return errors.New("managed artifact checksum file is incomplete")
	}
	for name, digest := range expected {
		actual, err := connectorSupervisorFileSHA256(filepath.Join(bundleRoot, name))
		if err != nil || actual != digest {
			return errors.New("managed artifact member failed its checksum")
		}
	}
	return nil
}

func connectorSupervisorFileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func equalConnectorSupervisorBundles(source, destination string, members map[string]fs.FileMode) error {
	names := make([]string, 0, len(members)-1)
	expectedModes := make(map[string]fs.FileMode, len(members)-1)
	for archiveName, mode := range members {
		name := strings.TrimPrefix(archiveName, filepath.Base(source)+"/")
		if name != filepath.Base(source) {
			names = append(names, name)
			expectedModes[name] = mode
		}
	}
	sort.Strings(names)
	for _, name := range names {
		sourceInfo, sourceInfoErr := os.Lstat(filepath.Join(source, name))
		destinationInfo, destinationInfoErr := os.Lstat(filepath.Join(destination, name))
		if sourceInfoErr != nil || destinationInfoErr != nil ||
			sourceInfo.Mode()&fs.ModeSymlink != 0 || destinationInfo.Mode()&fs.ModeSymlink != 0 ||
			!sourceInfo.Mode().IsRegular() || !destinationInfo.Mode().IsRegular() ||
			sourceInfo.Mode().Perm() != expectedModes[name].Perm() ||
			destinationInfo.Mode().Perm() != expectedModes[name].Perm() {
			return errors.New("existing managed release contains an unsafe member")
		}
		sourceHash, sourceErr := connectorSupervisorFileSHA256(filepath.Join(source, name))
		destinationHash, destinationErr := connectorSupervisorFileSHA256(filepath.Join(destination, name))
		if sourceErr != nil || destinationErr != nil || sourceHash != destinationHash {
			return errors.New("existing managed release does not match the verified artifact")
		}
	}
	entries, err := os.ReadDir(destination)
	if err != nil || len(entries) != len(names) {
		return errors.New("existing managed release contains unexpected files")
	}
	return nil
}
