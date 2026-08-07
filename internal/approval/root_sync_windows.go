//go:build windows

package approval

import "os"

func syncRootDirectory(*os.Root, string) error { return nil }
