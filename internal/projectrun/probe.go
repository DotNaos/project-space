package projectrun

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type NetworkProber struct {
	Client *http.Client
}

func (prober NetworkProber) Wait(ctx context.Context, target ProbeTarget, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		attempt, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
		lastErr = prober.Check(attempt, target)
		cancel()
		if lastErr == nil {
			return nil
		}
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), lastErr)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("probe %s:%d timed out: %w", target.Host, target.Port, lastErr)
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (prober NetworkProber) Check(ctx context.Context, target ProbeTarget) error {
	if target.Path == "" {
		dialer := net.Dialer{Timeout: 500 * time.Millisecond}
		connection, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(target.Host, strconv.Itoa(target.Port)))
		if err != nil {
			return err
		}
		return connection.Close()
	}
	requestURL := url.URL{
		Scheme: target.Scheme,
		Host:   net.JoinHostPort(target.Host, strconv.Itoa(target.Port)),
		Path:   target.Path,
	}
	if requestURL.Scheme == "" {
		requestURL.Scheme = "http"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return err
	}
	client := prober.Client
	if client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		if strings.HasSuffix(target.Host, ".review.vpn.os-home.net") {
			resolver := &net.Resolver{
				PreferGo: true,
				Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{Timeout: 500 * time.Millisecond}).DialContext(
						ctx, "udp", "1.1.1.1:53",
					)
				},
			}
			transport.DialContext = (&net.Dialer{
				Timeout: 500 * time.Millisecond, Resolver: resolver,
			}).DialContext
		}
		client = &http.Client{
			Transport: transport,
			Timeout:   750 * time.Millisecond,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return fmt.Errorf("health check returned %s", response.Status)
	}
	return nil
}
