package approvalsigner

import "errors"

var ErrUnavailable = errors.New("Secure Enclave approval signing is only available on a supported interactive macOS system")
var ErrAuthenticationCanceled = errors.New("Secure Enclave approval authentication was canceled")

// expectedHelperSHA256 is paired into trusted macOS builds with -ldflags.
// A repository-built CLI without this pin cannot issue human approvals.
var expectedHelperSHA256 string

type Signer struct{}

func New() *Signer { return &Signer{} }
