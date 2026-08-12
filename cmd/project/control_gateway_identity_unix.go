//go:build !windows

package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
)

func loadControlGatewayIdentity(path string) (controlGatewayIdentity, error) {
	installed, err := os.Lstat(path)
	if err != nil || !installed.Mode().IsRegular() || installed.Mode().Perm()&0022 != 0 {
		return controlGatewayIdentity{}, fmt.Errorf("control gateway identity is not trusted")
	}
	file, err := os.Open(path)
	if err != nil {
		return controlGatewayIdentity{}, fmt.Errorf("control gateway identity is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 ||
		!os.SameFile(installed, info) {
		return controlGatewayIdentity{}, fmt.Errorf("control gateway identity is not trusted")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 {
		return controlGatewayIdentity{}, fmt.Errorf("control gateway identity is not root-owned")
	}
	bounded, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil || len(bounded) > 64<<10 {
		return controlGatewayIdentity{}, fmt.Errorf("control gateway identity is invalid")
	}
	var identity controlGatewayIdentity
	if err := decodeControlFrame(strings.TrimSpace(string(bounded)), &identity); err != nil ||
		!validControlGatewayIdentity(identity) {
		return controlGatewayIdentity{}, fmt.Errorf("control gateway identity is invalid")
	}
	return identity, nil
}
