package codextask

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)
	operationIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)
	repositoryPattern  = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	threadIDPattern    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

func validateStartRequest(request StartRequest) error {
	if request.Issue <= 0 || !operationIDPattern.MatchString(request.OperationID) {
		return ErrInvalidInput
	}
	if request.RepositoryID != "" && !identifierPattern.MatchString(request.RepositoryID) && !repositoryPattern.MatchString(request.RepositoryID) {
		return ErrInvalidInput
	}
	return validateSelector(request.Selector, true)
}

func validateReadRequest(request ReadRequest) error {
	if !threadIDPattern.MatchString(request.ThreadID) || request.Last < 0 || request.Last > 10_000 {
		return ErrInvalidInput
	}
	return validateSelector(request.Selector, false)
}

func validateSendRequest(request SendRequest) error {
	if err := validateReadRequest(request.ReadRequest); err != nil {
		return err
	}
	if !operationIDPattern.MatchString(request.OperationID) || !validPromptText(request.Message, 16_000) {
		return ErrInvalidInput
	}
	return nil
}

func validateAttachRequest(request AttachRequest) error {
	if err := validateReadRequest(request.ReadRequest); err != nil {
		return err
	}
	if !operationIDPattern.MatchString(request.OperationID) {
		return ErrInvalidInput
	}
	return nil
}

func validateSelector(selector Selector, allowCurrent bool) error {
	if selector.EnvironmentID != "" && !identifierPattern.MatchString(selector.EnvironmentID) {
		return ErrInvalidInput
	}
	if selector.PhysicalMachineID != "" && !identifierPattern.MatchString(selector.PhysicalMachineID) {
		return ErrInvalidInput
	}
	if selector.PhysicalMachineName != "" && !validText(selector.PhysicalMachineName, 256) {
		return ErrInvalidInput
	}
	if selector.PhysicalMachineID != "" && selector.PhysicalMachineName != "" {
		return errors.New("select a physical machine by ID or name, not both")
	}
	if !allowCurrent && selector.EnvironmentID == "" && selector.PhysicalMachineID == "" && selector.PhysicalMachineName == "" {
		return errors.New("an environment ID or physical machine ID or name is required")
	}
	if selector.ConnectorID != "" && !identifierPattern.MatchString(selector.ConnectorID) {
		return ErrInvalidInput
	}
	return nil
}

func validText(value string, maximum int) bool {
	if value == "" || strings.TrimSpace(value) != value || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character) {
			return false
		}
	}
	return true
}

func validPromptText(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && utf8.ValidString(value) &&
		!strings.ContainsRune(value, '\x00') && strings.TrimSpace(value) != ""
}

func validateTarget(target Target) error {
	if !identifierPattern.MatchString(target.PhysicalMachine.ID) || !validText(target.PhysicalMachine.Name, 256) ||
		!identifierPattern.MatchString(target.Connector.ID) || !validText(target.Connector.Name, 256) ||
		target.Connector.Generation < 0 {
		return ErrInvalidResponse
	}
	if target.Connector.Environment != "" && !validText(target.Connector.Environment, 128) {
		return ErrInvalidResponse
	}
	if target.Environment != nil && (!identifierPattern.MatchString(target.Environment.ID) ||
		!validText(target.Environment.Name, 256)) {
		return ErrInvalidResponse
	}
	return nil
}

func targetMatchesSelector(target Target, selector Selector) bool {
	return (selector.ConnectorID == "" || selector.ConnectorID == target.Connector.ID) &&
		(selector.EnvironmentID == "" || (target.Environment != nil && selector.EnvironmentID == target.Environment.ID)) &&
		(selector.PhysicalMachineID == "" || selector.PhysicalMachineID == target.PhysicalMachine.ID) &&
		(selector.PhysicalMachineName == "" || selector.PhysicalMachineName == target.PhysicalMachine.Name)
}

func validateTask(task TaskIdentity) error {
	if validateTarget(task.Target) != nil || !threadIDPattern.MatchString(task.ThreadID) ||
		task.Issue.Number <= 0 || !identifierPattern.MatchString(task.Worktree.ID) ||
		!validText(task.Worktree.Branch, 512) || !identifierPattern.MatchString(task.Repository.ID) ||
		!validText(task.Repository.NameWithOwner, 512) {
		return ErrInvalidResponse
	}
	if task.Base != nil && (!validText(task.Base.Branch, 512) || !validText(task.Base.Commit, 128)) {
		return ErrInvalidResponse
	}
	if task.Workspace != nil && (!identifierPattern.MatchString(task.Workspace.ID) ||
		!validText(task.Workspace.Branch, 512) ||
		(task.Workspace.Path != "" && !validText(task.Workspace.Path, 2048))) {
		return ErrInvalidResponse
	}
	parsed, err := url.Parse(task.CanonicalTaskURL)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopbackHost(parsed.Hostname()))) {
		return ErrInvalidResponse
	}
	issueURL, err := url.Parse(task.Issue.URL)
	if err != nil || issueURL.Scheme != "https" || issueURL.Host == "" || issueURL.User != nil {
		return ErrInvalidResponse
	}
	return nil
}

func loopbackHost(host string) bool {
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func validBlockedReason(reason BlockedReason) bool {
	switch reason {
	case BlockedApprovalRequired, BlockedConnectorRequired, BlockedInputRequired,
		BlockedMachineNotReady, BlockedOffline, BlockedStaleConnector,
		BlockedThreadActive, BlockedUnauthorized, BlockedWorktreeFailure:
		return true
	default:
		return false
	}
}

func validateCommonResult(apiVersion int, operationID string, state ResultState, reason BlockedReason, reconcile string) error {
	if apiVersion != APIVersion || !operationIDPattern.MatchString(operationID) {
		return ErrInvalidResponse
	}
	if state == StateBlocked && !validBlockedReason(reason) {
		return ErrInvalidResponse
	}
	if state == StateUncertain && reconcile != "required" {
		return ErrInvalidResponse
	}
	return nil
}
