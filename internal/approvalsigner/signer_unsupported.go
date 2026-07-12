//go:build !darwin

package approvalsigner

func (*Signer) Enroll(string) error                                           { return ErrUnavailable }
func (*Signer) SignerID() (string, error)                                     { return "", ErrUnavailable }
func (*Signer) PublicKeyPEM() (string, error)                                 { return "", ErrUnavailable }
func (*Signer) SignPayload([]byte, string) ([]byte, error)                    { return nil, ErrUnavailable }
func (*Signer) ReadCheckpoint(string) ([]byte, bool, error)                   { return nil, false, ErrUnavailable }
func (*Signer) CommitCheckpoint([]byte, []byte, string, []byte, []byte) error { return ErrUnavailable }
