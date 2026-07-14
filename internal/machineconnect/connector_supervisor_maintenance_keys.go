package machineconnect

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

const maximumConnectorSupervisorPublicKeyBytes = 16 * 1024

var connectorSupervisorSignatureEncoding = base64.RawURLEncoding.Strict()

func decodeConnectorSupervisorSignature(value string) ([]byte, error) {
	decoded, err := connectorSupervisorSignatureEncoding.DecodeString(value)
	if err != nil || connectorSupervisorSignatureEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("signature encoding is invalid")
	}
	return decoded, nil
}

func readConnectorSupervisorPublicKey(path string) (ed25519.PublicKey, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() ||
		info.Mode().Perm()&0o022 != 0 || info.Size() < 1 ||
		info.Size() > maximumConnectorSupervisorPublicKeyBytes {
		return nil, errors.New("verification key file is unsafe")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil || parent.Mode()&fs.ModeSymlink != 0 || !parent.IsDir() ||
		parent.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("verification key directory is unsafe")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return nil, errors.New("verification key changed while opening")
	}
	body, err := io.ReadAll(io.LimitReader(file, maximumConnectorSupervisorPublicKeyBytes+1))
	if err != nil || len(body) > maximumConnectorSupervisorPublicKeyBytes {
		return nil, errors.New("verification key file is invalid")
	}
	block, rest := pem.Decode(body)
	if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 ||
		len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("verification key PEM is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, errors.New("verification key is invalid")
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, errors.New("verification key must be Ed25519")
	}
	return append(ed25519.PublicKey(nil), publicKey...), nil
}

func (maintenance *ConnectorSupervisorMaintenance) verifyCommandGrant(
	grant connectorSupervisorControlGrant,
) error {
	key, err := readConnectorSupervisorPublicKey(maintenance.commandVerificationKeyFile)
	if err != nil {
		return errors.New("command verification key is unavailable")
	}
	signature, err := decodeConnectorSupervisorSignature(grant.Signature)
	if err != nil || !ed25519.Verify(key, canonicalConnectorSupervisorGrant(grant), signature) {
		return errors.New("command grant signature is invalid")
	}
	return nil
}

func canonicalConnectorSupervisorGrant(grant connectorSupervisorControlGrant) []byte {
	body, _ := json.Marshal([]any{
		grant.UserID,
		grant.MachineID,
		grant.Generation,
		grant.Operation,
		grant.OperationID,
		grant.Target,
		grant.PreviousRuntimeSHA256,
		grant.PlanSHA256,
		grant.IssuedAt,
		grant.ExpiresAt,
		grant.Nonce,
	})
	return body
}

func (maintenance *ConnectorSupervisorMaintenance) verifyReleaseSignature(
	release connectorSupervisorSignedRelease,
) error {
	releaseKey, err := readConnectorSupervisorPublicKey(maintenance.releaseVerificationKeyFile)
	if err != nil {
		return errors.New("release verification key is unavailable")
	}
	commandKey, err := readConnectorSupervisorPublicKey(maintenance.commandVerificationKeyFile)
	if err != nil {
		return errors.New("command verification key is unavailable")
	}
	if bytes.Equal(commandKey, releaseKey) {
		return errors.New("release verification key must be dedicated")
	}
	manifestBody, err := json.Marshal(release.Manifest)
	if err != nil {
		return errors.New("release manifest cannot be encoded")
	}
	canonical, err := canonicalConnectorSupervisorJSON(manifestBody)
	if err != nil {
		return errors.New("release manifest is not canonical")
	}
	signature, err := decodeConnectorSupervisorSignature(release.Signature)
	if err != nil || !ed25519.Verify(releaseKey, canonical, signature) {
		return errors.New("release manifest signature is invalid")
	}
	return nil
}
