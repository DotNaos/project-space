package selfupdate

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const manifestTestVersion = "1.2.3"

func TestEmbeddedReleaseManifestPublicKeyMatchesPackagingTrustRoot(t *testing.T) {
	t.Parallel()
	want, err := os.ReadFile(filepath.Join("..", "..", "packaging", "release", "trust-roots", "release-manifest-signing-public-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	got := EmbeddedReleaseManifestPublicKey()
	if !bytes.Equal(got, want) {
		t.Fatal("embedded release manifest key does not match the packaging trust root")
	}
	got[0] ^= 0xff
	if bytes.Equal(got, EmbeddedReleaseManifestPublicKey()) {
		t.Fatal("EmbeddedReleaseManifestPublicKey returned mutable shared storage")
	}
}

func TestVerifySignedReleaseManifestAcceptsCanonicalSignedRelease(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	body, publicKey := manifestTestEnvelope(t, now, nil)
	release, err := verifySignedReleaseManifest(body, "v"+manifestTestVersion, "linux-x64", now, publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if release.Manifest.Version != manifestTestVersion || release.Artifact.Target != "linux-x64" {
		t.Fatalf("unexpected release: %#v", release)
	}
}

func TestVerifySignedReleaseManifestRejectsShapeAttacks(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	body, publicKey := manifestTestEnvelope(t, now, nil)
	valid := strings.TrimSpace(string(body))
	cases := map[string]string{
		"duplicate":      strings.Replace(valid, `"signature":`, `"signature":"ignored","signature":`, 1),
		"unknown":        strings.Replace(valid, `"signature":`, `"unknown":true,"signature":`, 1),
		"trailing":       valid + ` {}`,
		"nested unknown": strings.Replace(valid, `"target":"linux-x64"`, `"target":"linux-x64","unknown":true`, 1),
		"null array":     strings.Replace(valid, `"capabilities":["runtime.restart","runtime.update"]`, `"capabilities":null`, 1),
	}
	for name, candidate := range cases {
		candidate := candidate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := verifySignedReleaseManifest([]byte(candidate), "v"+manifestTestVersion, "linux-x64", now, publicKey); err == nil {
				t.Fatal("expected invalid JSON shape to be rejected")
			}
		})
	}
}

func TestVerifySignedReleaseManifestRejectsInvalidReleaseContracts(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	cases := map[string]func(*Manifest){
		"beta channel":          func(manifest *Manifest) { manifest.Channel = "beta" },
		"non-managed source":    func(manifest *Manifest) { manifest.Source = "source" },
		"mismatched release ID": func(manifest *Manifest) { manifest.ReleaseID = "v1.2.4" },
		"future issued": func(manifest *Manifest) {
			manifest.IssuedAt = now.Add(6 * time.Minute).Format("2006-01-02T15:04:05.000Z")
		},
		"expired":           func(manifest *Manifest) { manifest.ExpiresAt = now.Format("2006-01-02T15:04:05.000Z") },
		"mismatched bundle": func(manifest *Manifest) { manifest.Artifacts[0].BundleVersions.ProjectCLI = "1.2.4" },
		"mutable latest URL": func(manifest *Manifest) {
			manifest.Artifacts[0].DownloadURL = "https://github.com/DotNaos/project-space/releases/latest/download/project-space-machine-tools-linux-x64-v1.2.3.tar.gz"
		},
		"wrong asset": func(manifest *Manifest) {
			manifest.Artifacts[0].AssetName = "project-space-machine-tools-linux-x64.tar.gz"
		},
		"uppercase checksum": func(manifest *Manifest) { manifest.Artifacts[0].SHA256 = strings.Repeat("A", 64) },
		"duplicate target":   func(manifest *Manifest) { manifest.Artifacts = append(manifest.Artifacts, manifest.Artifacts[0]) },
	}
	for name, mutate := range cases {
		mutate := mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			body, publicKey := manifestTestEnvelope(t, now, mutate)
			if _, err := verifySignedReleaseManifest(body, "v"+manifestTestVersion, "linux-x64", now, publicKey); err == nil {
				t.Fatal("expected release contract violation to be rejected")
			}
		})
	}
}

func TestVerifySignedReleaseManifestRejectsTamperedSignatureAndUnsupportedTarget(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	body, publicKey := manifestTestEnvelope(t, now, nil)
	var signed SignedManifest
	if err := json.Unmarshal(body, &signed); err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(signed.Signature)
	if err != nil {
		t.Fatal(err)
	}
	signature[0] ^= 0xff
	signed.Signature = base64.RawURLEncoding.EncodeToString(signature)
	tampered, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifySignedReleaseManifest(tampered, "v"+manifestTestVersion, "linux-x64", now, publicKey); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("expected signature rejection, got %v", err)
	}
	if _, err := verifySignedReleaseManifest(body, "v"+manifestTestVersion, "darwin-arm64", now, publicKey); err == nil || !strings.Contains(err.Error(), "does not support") {
		t.Fatalf("expected target rejection, got %v", err)
	}
}

func TestCanonicalManifestJSONMatchesReleaseCanonicalFormat(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	manifest := manifestTestManifest(now)
	got, err := canonicalManifestJSON(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(got), `{"artifacts":[{"assetName":`) ||
		!strings.Contains(string(got), `"bundleVersions":{"connector":"1.2.3","machineTools":"1.2.3","projectCli":"1.2.3"}`) ||
		!strings.HasSuffix(string(got), `"version":"1.2.3"}`) {
		t.Fatalf("canonical JSON key ordering changed: %s", got)
	}
}

func manifestTestEnvelope(t *testing.T, now time.Time, mutate func(*Manifest)) ([]byte, []byte) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := manifestTestManifest(now)
	if mutate != nil {
		mutate(&manifest)
	}
	canonical, err := canonicalManifestJSON(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signed := SignedManifest{
		Manifest:  manifest,
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, canonical)),
	}
	body, err := json.Marshal(signed)
	if err != nil {
		t.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return body, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})
}

func manifestTestManifest(now time.Time) Manifest {
	assetName := "project-space-machine-tools-linux-x64-v" + manifestTestVersion + ".tar.gz"
	return Manifest{
		Artifacts: []Artifact{{
			AssetName: assetName,
			BundleVersions: BundleVersions{
				Connector: manifestTestVersion, MachineTools: manifestTestVersion, ProjectCLI: manifestTestVersion,
			},
			Capabilities:    []string{"runtime.restart", "runtime.update"},
			DownloadURL:     "https://github.com/DotNaos/project-space/releases/download/v" + manifestTestVersion + "/" + assetName,
			ProtocolVersion: "2",
			SHA256:          strings.Repeat("a", 64),
			SizeBytes:       1234,
			Target:          "linux-x64",
		}},
		BuildID:   strings.Repeat("b", 40),
		Channel:   "stable",
		ExpiresAt: now.Add(24 * time.Hour).Format("2006-01-02T15:04:05.000Z"),
		IssuedAt:  now.Add(-time.Hour).Format("2006-01-02T15:04:05.000Z"),
		ReleaseID: "v" + manifestTestVersion,
		Schema:    releaseManifestSchema,
		Source:    "managed",
		Version:   manifestTestVersion,
	}
}
