package approvalsigner

import "errors"

var ErrUnavailable = errors.New("Secure Enclave approval signing is only available on a supported interactive macOS system")

type Signer struct{}

func New() *Signer { return &Signer{} }
