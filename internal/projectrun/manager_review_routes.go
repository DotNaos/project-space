package projectrun

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
)

const reviewRouteAPITokenName = "REVIEW_ROUTE_API_TOKEN"

func (manager *Manager) startReviewRoute(
	ctx context.Context,
	state *runtimeState,
	config ReviewRouteConfig,
	expectedHostname string,
	healthPath string,
) error {
	leaseToken, err := manager.token()
	if err != nil {
		return fmt.Errorf("generate review route lease token: %w", err)
	}
	secrets, err := manager.secrets(ctx, map[string]string{
		reviewRouteAPITokenName: config.APIToken,
	})
	if err != nil {
		return fmt.Errorf("resolve review route API token: %w", err)
	}
	route, err := manager.reviewRoutes.Create(ctx, secrets[reviewRouteAPITokenName], ReviewRouteCreate{
		ProjectSlug:  config.ProjectSlug,
		TaskID:       state.ReviewTaskID,
		BackendIP:    state.TailscaleIPv4,
		BackendPort:  state.PublicPort,
		LeaseSeconds: reviewRouteLeaseSeconds,
		LeaseToken:   leaseToken,
	})
	if err != nil {
		return err
	}
	if route.ID == "" || route.Hostname != expectedHostname || route.BackendIP != state.TailscaleIPv4 ||
		route.BackendPort != state.PublicPort || route.ExpiresAt.IsZero() {
		mismatch := fmt.Errorf("review route API returned mismatched route evidence")
		if route.ID == "" {
			return mismatch
		}
		cleanupErr := manager.reviewRoutes.Delete(
			ctx,
			secrets[reviewRouteAPITokenName],
			route.ID,
			leaseToken,
		)
		if cleanupErr != nil {
			return errors.Join(mismatch, fmt.Errorf("delete mismatched review route: %w", cleanupErr))
		}
		return mismatch
	}
	state.ReviewRouteID = route.ID
	state.ReviewHostname = route.Hostname
	state.ReviewURL = "https://" + route.Hostname
	state.ReviewExpiresAt = route.ExpiresAt.UTC().Format(time.RFC3339Nano)
	state.ReviewLeaseToken = leaseToken
	state.ReviewAPITokenRef = config.APIToken
	if err := manager.store.save(*state); err != nil {
		return err
	}
	executable, err := manager.executable()
	if err != nil {
		return fmt.Errorf("resolve Project CLI executable for review heartbeat: %w", err)
	}
	command := Command{
		Argv: []string{executable, ReviewRouteHeartbeatCommandName},
		Env: mergeEnvironment(nil, map[string]string{
			"PROJECT_REVIEW_ROUTE_API_URL":       defaultReviewRouteAPIURL,
			"PROJECT_REVIEW_ROUTE_ID":            state.ReviewRouteID,
			"PROJECT_REVIEW_ROUTE_LEASE_TOKEN":   state.ReviewLeaseToken,
			"PROJECT_REVIEW_ROUTE_LEASE_SECONDS": strconv.Itoa(reviewRouteLeaseSeconds),
			"PROJECT_REVIEW_ROUTE_BACKEND_IP":    state.TailscaleIPv4,
			"PROJECT_REVIEW_ROUTE_BACKEND_PORT":  strconv.Itoa(state.PublicPort),
			"PROJECT_REVIEW_ROUTE_HEALTH_PATH":   healthPath,
		}),
		SecretEnvironment: map[string]string{reviewRouteAPITokenName: config.APIToken},
	}
	process, err := manager.processes.StartDetached(
		command,
		manager.store.reviewLogPath(state.ServerID),
		func(process ProcessRef) error {
			state.ReviewPID = process.PID
			state.ReviewProcessID = process.Identity
			return manager.store.save(*state)
		},
	)
	if err != nil {
		return fmt.Errorf("start review route heartbeat: %w", err)
	}
	state.ReviewPID = process.PID
	state.ReviewProcessID = process.Identity
	return manager.store.save(*state)
}

func (manager *Manager) cleanupReviewRoute(ctx context.Context, state runtimeState) error {
	if state.ReviewRouteID == "" {
		return nil
	}
	var failures []error
	secrets, err := manager.secrets(ctx, map[string]string{
		reviewRouteAPITokenName: state.ReviewAPITokenRef,
	})
	if err != nil {
		failures = append(failures, fmt.Errorf("resolve review route API token for cleanup: %w", err))
	} else if err := manager.reviewRoutes.Delete(
		ctx,
		secrets[reviewRouteAPITokenName],
		state.ReviewRouteID,
		state.ReviewLeaseToken,
	); err != nil {
		failures = append(failures, err)
	}
	if state.ReviewPID > 0 {
		process := ProcessRef{PID: state.ReviewPID, Identity: state.ReviewProcessID}
		if manager.processes.Alive(process) {
			if err := manager.processes.StopGroup(process, 3*time.Second); err != nil {
				failures = append(failures, fmt.Errorf("stop review route heartbeat: %w", err))
			}
		}
	}
	return errors.Join(failures...)
}
