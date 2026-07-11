//go:build !darwin

package approvalsigner

func (*Signer) Enroll(string) error                        { return ErrUnavailable }
func (*Signer) SignerID() (string, error)                  { return "", ErrUnavailable }
func (*Signer) PublicKeyPEM() (string, error)              { return "", ErrUnavailable }
func (*Signer) SignPayload([]byte, string) ([]byte, error) { return nil, ErrUnavailable }
