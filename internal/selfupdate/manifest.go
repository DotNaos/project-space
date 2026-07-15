package selfupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	releaseManifestSchema       = "project-space.connector-runtime-release/v1"
	maximumArtifactBytes        = 2 * 1024 * 1024 * 1024
	maximumManifestLifetime     = 370 * 24 * time.Hour
	manifestClockSkew           = 5 * time.Minute
	releaseManifestAssetName    = "project-space-release-manifest.json"
	releaseManifestMaximumBytes = 1 << 20
)

var (
	//go:embed release-manifest-signing-public-key.pem
	embeddedReleaseManifestPublicKey []byte

	semanticVersionPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
	releaseIDPattern       = regexp.MustCompile(`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
	buildIDPattern         = regexp.MustCompile(`^[0-9a-f]{40}$`)
	assetNamePattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$`)
	capabilityPattern      = regexp.MustCompile(`^[a-z][a-z0-9.-]{0,127}$`)
	protocolVersionPattern = regexp.MustCompile(`^[1-9]\d{0,7}$`)
	timestampPattern       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	signatureEncoding      = base64.RawURLEncoding.Strict()
)

// EmbeddedReleaseManifestPublicKey returns a copy of the release trust root
// compiled into the Project CLI.
func EmbeddedReleaseManifestPublicKey() []byte {
	return append([]byte(nil), embeddedReleaseManifestPublicKey...)
}

func verifySignedReleaseManifest(body []byte, expectedReleaseID, target string, now time.Time, publicKeyPEM []byte) (Release, error) {
	var signed SignedManifest
	generic, err := decodeExactJSON(body, &signed)
	if err != nil {
		return Release{}, fmt.Errorf("release manifest has an invalid JSON shape: %w", err)
	}
	if err := validateSignedManifestShape(generic); err != nil {
		return Release{}, err
	}
	if err := validateManifest(signed.Manifest, expectedReleaseID, now); err != nil {
		return Release{}, err
	}
	signature, err := signatureEncoding.DecodeString(signed.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize || signatureEncoding.EncodeToString(signature) != signed.Signature {
		return Release{}, errors.New("release manifest signature encoding is invalid")
	}
	publicKey, err := parseReleaseManifestPublicKey(publicKeyPEM)
	if err != nil {
		return Release{}, err
	}
	canonical, err := canonicalManifestJSON(signed.Manifest)
	if err != nil {
		return Release{}, fmt.Errorf("release manifest cannot be canonicalized: %w", err)
	}
	if !ed25519.Verify(publicKey, canonical, signature) {
		return Release{}, errors.New("release manifest signature is invalid")
	}
	for _, artifact := range signed.Manifest.Artifacts {
		if artifact.Target == target {
			return Release{Artifact: artifact, Manifest: signed.Manifest}, nil
		}
	}
	return Release{}, fmt.Errorf("release manifest does not support target %q", target)
}

func validateManifest(manifest Manifest, expectedReleaseID string, now time.Time) error {
	if manifest.Schema != releaseManifestSchema || !buildIDPattern.MatchString(manifest.BuildID) ||
		manifest.Channel != "stable" || manifest.Source != "managed" ||
		!semanticVersionPattern.MatchString(manifest.Version) ||
		!releaseIDPattern.MatchString(manifest.ReleaseID) || manifest.ReleaseID != "v"+manifest.Version ||
		manifest.ReleaseID != expectedReleaseID {
		return errors.New("release manifest identity does not match the exact stable managed release")
	}
	issuedAt, err := parseManifestTimestamp(manifest.IssuedAt)
	if err != nil {
		return errors.New("release manifest issue time is invalid")
	}
	expiresAt, err := parseManifestTimestamp(manifest.ExpiresAt)
	if err != nil {
		return errors.New("release manifest expiry time is invalid")
	}
	if issuedAt.After(now.Add(manifestClockSkew)) {
		return errors.New("release manifest was issued in the future")
	}
	if !expiresAt.After(now) {
		return errors.New("release manifest has expired")
	}
	if !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > maximumManifestLifetime {
		return errors.New("release manifest validity period is invalid")
	}
	if len(manifest.Artifacts) == 0 || len(manifest.Artifacts) > 3 {
		return errors.New("release manifest artifact count is invalid")
	}
	seenTargets := make(map[string]struct{}, len(manifest.Artifacts))
	for _, artifact := range manifest.Artifacts {
		if _, duplicate := seenTargets[artifact.Target]; duplicate {
			return errors.New("release manifest contains a duplicate target")
		}
		seenTargets[artifact.Target] = struct{}{}
		if err := validateArtifact(artifact, manifest); err != nil {
			return err
		}
	}
	return nil
}

func validateArtifact(artifact Artifact, manifest Manifest) error {
	expectedName := ""
	switch artifact.Target {
	case "darwin-arm64", "linux-x64":
		expectedName = fmt.Sprintf("project-space-machine-tools-%s-v%s.tar.gz", artifact.Target, manifest.Version)
	case "windows-x64":
		expectedName = "project-space-machine-tools-windows-x64-setup.exe"
	default:
		return fmt.Errorf("release manifest target %q is unsupported", artifact.Target)
	}
	if artifact.AssetName != expectedName || !assetNamePattern.MatchString(artifact.AssetName) || strings.Contains(artifact.AssetName, "..") {
		return fmt.Errorf("release manifest asset name for %s is invalid", artifact.Target)
	}
	expectedURL := fmt.Sprintf("https://github.com/DotNaos/project-space/releases/download/%s/%s", manifest.ReleaseID, artifact.AssetName)
	if artifact.DownloadURL != expectedURL || !isExactGitHubReleaseURL(artifact.DownloadURL) {
		return fmt.Errorf("release manifest download URL for %s is invalid", artifact.Target)
	}
	if artifact.BundleVersions.Connector != manifest.Version ||
		artifact.BundleVersions.MachineTools != manifest.Version ||
		artifact.BundleVersions.ProjectCLI != manifest.Version {
		return fmt.Errorf("release manifest bundle versions for %s do not match", artifact.Target)
	}
	if !semanticVersionPattern.MatchString(artifact.BundleVersions.Connector) ||
		!semanticVersionPattern.MatchString(artifact.BundleVersions.MachineTools) ||
		!semanticVersionPattern.MatchString(artifact.BundleVersions.ProjectCLI) {
		return fmt.Errorf("release manifest bundle versions for %s are invalid", artifact.Target)
	}
	if !protocolVersionPattern.MatchString(artifact.ProtocolVersion) ||
		artifact.SizeBytes <= 0 || artifact.SizeBytes > maximumArtifactBytes ||
		len(artifact.SHA256) != 64 {
		return fmt.Errorf("release manifest artifact metadata for %s is invalid", artifact.Target)
	}
	if decoded, err := hex.DecodeString(artifact.SHA256); err != nil || len(decoded) != 32 || strings.ToLower(artifact.SHA256) != artifact.SHA256 {
		return fmt.Errorf("release manifest checksum for %s is invalid", artifact.Target)
	}
	if len(artifact.Capabilities) > 64 {
		return fmt.Errorf("release manifest capabilities for %s are invalid", artifact.Target)
	}
	seenCapabilities := make(map[string]struct{}, len(artifact.Capabilities))
	for index, capability := range artifact.Capabilities {
		if !capabilityPattern.MatchString(capability) {
			return fmt.Errorf("release manifest capability for %s is invalid", artifact.Target)
		}
		if _, duplicate := seenCapabilities[capability]; duplicate || (index > 0 && artifact.Capabilities[index-1] >= capability) {
			return fmt.Errorf("release manifest capabilities for %s are not unique and sorted", artifact.Target)
		}
		seenCapabilities[capability] = struct{}{}
	}
	return nil
}

func parseManifestTimestamp(value string) (time.Time, error) {
	if !timestampPattern.MatchString(value) {
		return time.Time{}, errors.New("timestamp is not canonical")
	}
	return time.Parse("2006-01-02T15:04:05.000Z", value)
}

func isExactGitHubReleaseURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "github.com" && parsed.User == nil &&
		parsed.RawQuery == "" && parsed.Fragment == ""
}

func parseReleaseManifestPublicKey(body []byte) (ed25519.PublicKey, error) {
	block, rest := pem.Decode(body)
	if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("release manifest verification key is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, errors.New("release manifest verification key is invalid")
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("release manifest verification key must be Ed25519")
	}
	return append(ed25519.PublicKey(nil), key...), nil
}

func decodeExactJSON(body []byte, output any) (any, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, errors.New("JSON is empty")
	}
	if err := rejectDuplicateJSONKeys(body); err != nil {
		return nil, err
	}
	var generic any
	genericDecoder := json.NewDecoder(bytes.NewReader(body))
	genericDecoder.UseNumber()
	if err := genericDecoder.Decode(&generic); err != nil {
		return nil, errors.New("JSON is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return nil, errors.New("JSON has an invalid shape")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("JSON must contain exactly one value")
	}
	return generic, nil
}

func rejectDuplicateJSONKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("JSON must contain exactly one value")
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("JSON is invalid")
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			key, keyOK := keyToken.(string)
			if err != nil || !keyOK {
				return errors.New("JSON object key is invalid")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("JSON contains a duplicate key")
			}
			seen[key] = struct{}{}
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		if closing, err := decoder.Token(); err != nil || closing != json.Delim('}') {
			return errors.New("JSON object is incomplete")
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		if closing, err := decoder.Token(); err != nil || closing != json.Delim(']') {
			return errors.New("JSON array is incomplete")
		}
	default:
		return errors.New("JSON delimiter is invalid")
	}
	return nil
}

func validateSignedManifestShape(value any) error {
	root, ok := value.(map[string]any)
	if !ok || !hasExactKeys(root, "manifest", "signature") {
		return errors.New("signed release manifest has an invalid shape")
	}
	manifest, ok := root["manifest"].(map[string]any)
	if !ok || !hasExactKeys(manifest, "artifacts", "buildId", "channel", "expiresAt", "issuedAt", "releaseId", "schema", "source", "version") {
		return errors.New("release manifest has an invalid shape")
	}
	artifacts, ok := manifest["artifacts"].([]any)
	if !ok {
		return errors.New("release manifest artifacts have an invalid shape")
	}
	for _, value := range artifacts {
		artifact, ok := value.(map[string]any)
		if !ok || !hasExactKeys(artifact, "assetName", "bundleVersions", "capabilities", "downloadUrl", "protocolVersion", "sha256", "sizeBytes", "target") {
			return errors.New("release manifest artifact has an invalid shape")
		}
		bundle, ok := artifact["bundleVersions"].(map[string]any)
		if !ok || !hasExactKeys(bundle, "connector", "machineTools", "projectCli") {
			return errors.New("release manifest bundle versions have an invalid shape")
		}
		if _, ok := artifact["capabilities"].([]any); !ok {
			return errors.New("release manifest capabilities have an invalid shape")
		}
	}
	return nil
}

func hasExactKeys(value map[string]any, expected ...string) bool {
	if len(value) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	return true
}

func canonicalManifestJSON(manifest Manifest) ([]byte, error) {
	body, err := json.Marshal(manifest)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var output strings.Builder
	if err := writeCanonicalJSON(&output, value); err != nil {
		return nil, err
	}
	return []byte(output.String()), nil
}

func writeCanonicalJSON(output *strings.Builder, value any) error {
	switch typed := value.(type) {
	case nil:
		output.WriteString("null")
	case bool:
		output.WriteString(strconv.FormatBool(typed))
	case string:
		encoded, _ := json.Marshal(typed)
		output.Write(encoded)
	case json.Number:
		integer, err := strconv.ParseInt(string(typed), 10, 64)
		if err != nil || integer < -9_007_199_254_740_991 || integer > 9_007_199_254_740_991 || integer == math.MinInt64 {
			return errors.New("canonical JSON accepts safe integers only")
		}
		output.WriteString(strconv.FormatInt(integer, 10))
	case []any:
		output.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeCanonicalJSON(output, entry); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encoded, _ := json.Marshal(key)
			output.Write(encoded)
			output.WriteByte(':')
			if err := writeCanonicalJSON(output, typed[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return fmt.Errorf("canonical JSON contains unsupported value %T", value)
	}
	return nil
}
