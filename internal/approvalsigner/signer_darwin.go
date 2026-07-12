//go:build darwin

package approvalsigner

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func (*Signer) Enroll(reason string) error {
	_, err := runHelper("enroll", base64.StdEncoding.EncodeToString([]byte(reason)))
	return err
}

func (s *Signer) SignerID() (string, error) {
	der, err := s.publicKeyDER()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func (s *Signer) PublicKeyPEM() (string, error) {
	der, err := s.publicKeyDER()
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

func (*Signer) publicKeyDER() ([]byte, error) {
	output, err := runHelper("public-key")
	if err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(output))
	if err != nil {
		return nil, fmt.Errorf("native signer returned invalid public key: %w", err)
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), raw)
	if x == nil {
		return nil, fmt.Errorf("Secure Enclave returned an invalid P-256 public key")
	}
	return x509.MarshalPKIXPublicKey(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y})
}

func (s *Signer) SignPayload(payload []byte, reason string) ([]byte, error) {
	output, err := runHelper("sign", base64.StdEncoding.EncodeToString(payload), base64.StdEncoding.EncodeToString([]byte(reason)))
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(output))
}

func runHelper(arguments ...string) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	path := filepath.Join(filepath.Dir(executable), "project-approval-signer")
	if expectedHelperSHA256 == "" {
		return "", fmt.Errorf("Secure Enclave helper hash is not pinned in this Project CLI build")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read Secure Enclave helper: %w", err)
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != expectedHelperSHA256 {
		return "", fmt.Errorf("Secure Enclave helper does not match this trusted Project CLI build")
	}
	requirement := `=anchor apple generic and certificate leaf[subject.OU] = "R72P4M9WMS" and identifier "com.dotnaos.project.approval-signer"`
	if output, err := exec.Command("/usr/bin/codesign", "--verify", "--strict", "--test-requirement", requirement, path).CombinedOutput(); err != nil {
		return "", fmt.Errorf("Secure Enclave helper is not a trusted signed Project component: %s", strings.TrimSpace(string(output)))
	}
	output, err := exec.Command(path, arguments...).CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "PROJECT_AUTHENTICATION_CANCELED") {
			return "", ErrAuthenticationCanceled
		}
		return "", fmt.Errorf("Secure Enclave helper failed: %s", strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
