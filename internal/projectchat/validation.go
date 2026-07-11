package projectchat

import (
	"io"
	"net"
	"net/url"
	"strings"
	"unicode/utf16"
)

func parseBaseURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, ErrInvalidBaseURL
	}
	if parsed.Scheme == "https" {
		return parsed, nil
	}
	if parsed.Scheme != "http" || !isLoopbackHost(parsed.Hostname()) {
		return nil, ErrInvalidBaseURL
	}
	return parsed, nil
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "localhost" {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func validateCredential(accessToken string) error {
	if accessToken == "" {
		return ErrMissingCredential
	}
	if len(accessToken) > maxCredentialBytes || strings.TrimSpace(accessToken) != accessToken {
		return ErrInvalidCredential
	}
	for _, character := range accessToken {
		if character < 0x21 || character > 0x7e {
			return ErrInvalidCredential
		}
	}
	return nil
}

func validateChannelID(channelID string) error {
	if channelID != GeneralChannel {
		return ErrInvalidRequest
	}
	return nil
}

func validMachineID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune("._:-", character) {
			continue
		}
		return false
	}
	return true
}

func validateIdempotencyKey(key string) error {
	if len(key) == 0 || len(key) > maxIdempotencyBytes {
		return ErrInvalidRequest
	}
	for _, character := range key {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune("-_.:", character) {
			continue
		}
		return ErrInvalidRequest
	}
	return nil
}

func validateMessage(message Message, channelID string) error {
	if !validResponseIdentifier(message.ID, 128) || message.ChannelID != channelID || message.Sequence == 0 ||
		strings.TrimSpace(message.Body) == "" || validateSender(message.Sender) != nil ||
		message.CreatedAt.IsZero() || message.ExpiresAt.IsZero() || !message.ExpiresAt.After(message.CreatedAt) {
		return ErrInvalidResponse
	}
	if utf16Length(message.Body) > MaxMessageCharacters {
		return ErrInvalidResponse
	}
	return nil
}

func validateAgentProfile(profile AgentProfile) error {
	if strings.TrimSpace(profile.DisplayName) != profile.DisplayName ||
		strings.TrimSpace(profile.TaskTitle) != profile.TaskTitle ||
		!validProfileText(profile.DisplayName, maxAgentNameCharacters, false) ||
		!validProfileText(profile.TaskTitle, maxTaskTitleCharacters, true) {
		return ErrInvalidAgentName
	}
	return nil
}

func validateAgentSender(sender Sender, threadID string) error {
	if err := validateSender(sender); err != nil || sender.Role != "agent" ||
		sender.Origin == nil || sender.Origin.ThreadID != threadID {
		return ErrInvalidResponse
	}
	return nil
}

func validateSender(sender Sender) error {
	if !validResponseIdentifier(sender.MemberID, 128) ||
		!validResponseText(sender.DisplayName, 48) ||
		!validResponseHandle(sender.Handle) {
		return ErrInvalidResponse
	}
	switch sender.Role {
	case "agent":
		if sender.Origin == nil || validateThreadID(sender.Origin.ThreadID) != nil ||
			!validResponseIdentifier(sender.Origin.HostID, 128) ||
			!validResponseIdentifier(sender.Origin.MachineID, 128) ||
			(sender.Origin.TaskTitle != "" && !validResponseText(sender.Origin.TaskTitle, maxTaskTitleCharacters)) {
			return ErrInvalidResponse
		}
	case "human", "system":
		if sender.Origin != nil {
			return ErrInvalidResponse
		}
	default:
		return ErrInvalidResponse
	}
	return nil
}

func validResponseIdentifier(value string, maxBytes int) bool {
	if value == "" || len(value) > maxBytes {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune("._:/-", character) {
			continue
		}
		return false
	}
	return true
}

func validResponseText(value string, maxCharacters int) bool {
	return strings.TrimSpace(value) == value && validProfileText(value, maxCharacters, false)
}

func validResponseHandle(value string) bool {
	if value == "" || len(value) > 32 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func validateReadResult(result ReadResult, channelID string, limit int) error {
	if result.ChannelID != channelID || len(result.Messages) > limit ||
		result.NextSequence < result.AfterSequence || result.NextSequence > result.LatestSequence ||
		(result.HasMore && (len(result.Messages) == 0 || result.NextSequence >= result.LatestSequence)) {
		return ErrInvalidResponse
	}
	previousSequence := result.AfterSequence
	for _, message := range result.Messages {
		if err := validateMessage(message, channelID); err != nil || message.Sequence <= previousSequence || message.Sequence > result.NextSequence {
			return ErrInvalidResponse
		}
		previousSequence = message.Sequence
	}
	if len(result.Messages) > 0 && previousSequence != result.NextSequence {
		return ErrInvalidResponse
	}
	return nil
}

func readLimited(reader io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, MaxResponseBytes+1))
	if err != nil {
		return nil, ErrInvalidResponse
	}
	if int64(len(body)) > MaxResponseBytes {
		return nil, ErrResponseTooLarge
	}
	return body, nil
}

func utf16Length(value string) int {
	length := 0
	for _, character := range value {
		length += utf16.RuneLen(character)
	}
	return length
}
