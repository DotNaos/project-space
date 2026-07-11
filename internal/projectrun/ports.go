package projectrun

import (
	"fmt"
	"net"
)

const (
	publicPortStart = 44000
	publicPortEnd   = 44999
)

type NetworkPortAllocator struct{}

func (NetworkPortAllocator) Local(reserved map[int]bool) (int, error) {
	for attempt := 0; attempt < 20; attempt++ {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return 0, fmt.Errorf("reserve local port: %w", err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		if err := listener.Close(); err != nil {
			return 0, fmt.Errorf("release local port reservation: %w", err)
		}
		if !reserved[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("could not allocate an unused local port")
}

func (NetworkPortAllocator) Public(reserved map[int]bool) (int, error) {
	for port := publicPortStart; port <= publicPortEnd; port++ {
		if !reserved[port] {
			return port, nil
		}
	}
	return 0, fmt.Errorf("no Tailscale port is available in %d-%d", publicPortStart, publicPortEnd)
}
