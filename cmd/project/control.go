package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/DotNaos/project-space/internal/computecontrol"
	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/workspacerun"
	"github.com/spf13/cobra"
)

const controlSchemaVersion = 1
const controlGatewayIdentityPath = "/etc/project-space/environment-identity.json"

var (
	controlEnvironmentIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
	controlOperationIDPattern   = regexp.MustCompile(`^[A-Za-z0-9:._-]{1,256}$`)
	controlRevisionPattern      = regexp.MustCompile(`^[A-Za-z0-9:._-]{8,256}$`)
)

type controlHandshakeResult struct {
	CLIVersion      string   `json:"cliVersion"`
	Operations      []string `json:"operations"`
	ProtocolVersion int      `json:"protocolVersion"`
	SchemaVersion   int      `json:"schemaVersion"`
	Type            string   `json:"type,omitempty"`
}

type controlStatusResult struct {
	CheckedAt              string `json:"checkedAt"`
	Operation              string `json:"operation"`
	SchemaVersion          int    `json:"schemaVersion"`
	State                  string `json:"state"`
	Type                   string `json:"type,omitempty"`
	OperationID            string `json:"operationId,omitempty"`
	TargetIdentityRevision string `json:"targetIdentityRevision,omitempty"`
}

type controlGatewayHandshakeRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Type          string `json:"type"`
}

type controlGatewayOperationRequest struct {
	EnvironmentID              string   `json:"environmentId"`
	ExpectedCLIVersion         string   `json:"expectedCliVersion"`
	ExpectedProtocolVersion    int      `json:"expectedProtocolVersion"`
	Operation                  string   `json:"operation"`
	OperationID                string   `json:"operationId"`
	SchemaVersion              int      `json:"schemaVersion"`
	TargetIdentityRevision     string   `json:"targetIdentityRevision"`
	Type                       string   `json:"type"`
	WorkspaceID                string   `json:"workspaceId,omitempty"`
	ExpectedBranch             string   `json:"expectedBranch,omitempty"`
	ExpectedCommit             string   `json:"expectedCommit,omitempty"`
	ExpectedManifestDigest     string   `json:"expectedManifestDigest,omitempty"`
	ExpectedGeneration         string   `json:"expectedGeneration,omitempty"`
	ExpectedRuntimeVersion     string   `json:"expectedRuntimeVersion,omitempty"`
	Mode                       string   `json:"mode,omitempty"`
	RuntimeSessionEndpoint     string   `json:"runtimeSessionEndpoint,omitempty"`
	RuntimeSessionToken        string   `json:"runtimeSessionToken,omitempty"`
	RuntimeSessionExpiresAt    string   `json:"runtimeSessionExpiresAt,omitempty"`
	RuntimeSessionVersion      string   `json:"runtimeSessionVersion,omitempty"`
	RuntimeSessionCapabilities []string `json:"runtimeSessionCapabilities,omitempty"`
}

type controlGatewayIdentity struct {
	EnvironmentID          string            `json:"environmentId"`
	TargetIdentityRevision string            `json:"targetIdentityRevision"`
	Workspaces             map[string]string `json:"workspaces,omitempty"`
}

type controlCommandDependencies struct {
	Inventory      computeInventoryCommandDependencies
	Load           func(context.Context) (computecontrol.API, error)
	NewOperationID func(string) (string, error)
}

func defaultControlCommandDependencies() controlCommandDependencies {
	return controlCommandDependencies{
		Inventory:      defaultComputeInventoryCommandDependencies(),
		Load:           loadComputeControlClient,
		NewOperationID: newCodexOperationID,
	}
}

func loadComputeControlClient(context.Context) (computecontrol.API, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return nil, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return nil, errors.New("this machine is not connected to Project Space")
	}
	token := credential.Token
	return computecontrol.NewClient(computecontrol.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: computecontrol.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
}

func newControlCommand() *cobra.Command {
	return newControlCommandWithDependencies(defaultControlCommandDependencies())
}

func newControlCommandWithDependencies(dependencies controlCommandDependencies) *cobra.Command {
	command := &cobra.Command{
		Use:   "control",
		Short: "Run typed control-gateway operations",
	}
	command.AddCommand(&cobra.Command{
		Use: "handshake", Short: "Describe the installed control protocol", Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			return writeJSON(command.OutOrStdout(), controlHandshakeResult{
				CLIVersion: projectMachineClientVersion, Operations: controlOperations(),
				ProtocolVersion: 1, SchemaVersion: controlSchemaVersion,
			})
		},
	})
	options := inventoryFormatOptions{format: "text"}
	operationID := ""
	status := &cobra.Command{
		Use:   "status <environment-instance>",
		Short: "Verify one Environment through the typed SSH gateway",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			format, err := options.resolve()
			if err != nil {
				return err
			}
			inventory, err := loadComputeInventory(command.Context(), dependencies.Inventory)
			if err != nil {
				return err
			}
			instance, err := resolveEnvironmentInstance(inventory.EnvironmentInstances, args[0])
			if err != nil {
				return err
			}
			if operationID == "" {
				operationID, err = dependencies.NewOperationID("control-status")
				if err != nil {
					return errors.New("create control operation ID")
				}
			}
			client, err := dependencies.Load(command.Context())
			if err != nil {
				return err
			}
			result, err := client.Status(command.Context(), computecontrol.StatusRequest{
				EnvironmentID: instance.ID,
				OperationID:   operationID,
			})
			if err != nil {
				return fmt.Errorf("control operation %s: %w", operationID, err)
			}
			if format == "json" {
				return writeJSON(command.OutOrStdout(), result)
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(), "%s ready via SSH control (operation %s, replayed %t)\n",
				instance.Reference, result.Result.OperationID, result.Replayed,
			)
			return err
		},
	}
	options.addFlags(status, true)
	status.Flags().StringVar(&operationID, "operation-id", "", "reuse one exact idempotent operation ID")
	command.AddCommand(status)
	return command
}

func newControlGatewayCommand() *cobra.Command {
	var stdio bool
	command := &cobra.Command{
		Use: "control-gateway", Short: "Serve the typed SSH control protocol",
		Args: cobra.NoArgs, Hidden: true,
		RunE: func(command *cobra.Command, _ []string) error {
			if !stdio {
				return fmt.Errorf("control gateway requires --stdio")
			}
			identity, err := loadControlGatewayIdentity(controlGatewayIdentityPath)
			if err != nil {
				return err
			}
			return serveControlGateway(command.InOrStdin(), command.OutOrStdout(), identity)
		},
	}
	command.Flags().BoolVar(&stdio, "stdio", false, "serve bounded JSON frames over stdin")
	command.AddCommand(newControlGatewayInstallIdentityCommand())
	return command
}

func serveControlGateway(input io.Reader, output io.Writer, identity controlGatewayIdentity) error {
	return serveControlGatewayWithRuntime(input, output, identity, func() (workspaceRuntimeManager, error) {
		return workspacerun.NewDefaultManager()
	})
}

func serveControlGatewayWithRuntime(
	input io.Reader,
	output io.Writer,
	identity controlGatewayIdentity,
	runtimeFactory func() (workspaceRuntimeManager, error),
) error {
	scanner := bufio.NewScanner(io.LimitReader(input, 16*1024+1))
	scanner.Buffer(make([]byte, 1024), 8*1024)
	if !scanner.Scan() {
		return fmt.Errorf("missing control handshake")
	}
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(scanner.Text()), &envelope); err != nil {
		return fmt.Errorf("invalid control frame")
	}
	if envelope.Type == "handshake" {
		var handshake controlGatewayHandshakeRequest
		if err := decodeControlFrame(scanner.Text(), &handshake); err != nil ||
			handshake.SchemaVersion != controlSchemaVersion {
			return fmt.Errorf("invalid control handshake")
		}
		if scanner.Scan() {
			return fmt.Errorf("handshake must complete before an operation")
		}
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("read control frame: %w", err)
		}
		return writeControlFrame(output, controlHandshakeResult{
			CLIVersion: projectMachineClientVersion, Operations: controlOperations(),
			ProtocolVersion: 1, SchemaVersion: controlSchemaVersion, Type: "handshake",
		})
	}
	if envelope.Type != "operation" {
		return fmt.Errorf("invalid control frame")
	}
	var request controlGatewayOperationRequest
	if err := decodeControlFrame(scanner.Text(), &request); err != nil ||
		request.SchemaVersion != controlSchemaVersion || request.Type != "operation" ||
		request.ExpectedProtocolVersion != 1 ||
		request.ExpectedCLIVersion != projectMachineClientVersion ||
		!controlEnvironmentIDPattern.MatchString(request.EnvironmentID) ||
		!controlOperationIDPattern.MatchString(request.OperationID) ||
		!controlRevisionPattern.MatchString(request.TargetIdentityRevision) ||
		request.EnvironmentID != identity.EnvironmentID ||
		request.TargetIdentityRevision != identity.TargetIdentityRevision {
		return fmt.Errorf("invalid control operation")
	}
	if scanner.Scan() {
		return fmt.Errorf("unexpected control frame")
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read control frame: %w", err)
	}
	if request.Operation != "status.v1" {
		return executeWorkspaceRuntimeControl(output, identity, request, runtimeFactory)
	}
	return writeControlFrame(output, controlStatusResult{
		CheckedAt: time.Now().UTC().Format(time.RFC3339Nano), Operation: "status.v1",
		OperationID: request.OperationID, SchemaVersion: controlSchemaVersion, State: "ready",
		TargetIdentityRevision: identity.TargetIdentityRevision, Type: "result",
	})
}

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

func writeControlFrame(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func decodeControlFrame(value string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("trailing control data")
	}
	return nil
}
