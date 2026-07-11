package projectchat

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const agentProfilesVersion = "1"

type AgentProfileStore interface {
	Load(threadID string) (AgentProfile, error)
	Save(threadID string, profile AgentProfile) error
}

type FileAgentProfileStore struct {
	Path string
}

type agentProfileFile struct {
	Version  string                  `json:"version"`
	Profiles map[string]AgentProfile `json:"profiles"`
}

func NewDefaultAgentProfileStore() (*FileAgentProfileStore, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("resolve Project Chat profile directory: %w", err)
	}
	return &FileAgentProfileStore{Path: filepath.Join(directory, "project-space", "chat-agent-profiles.json")}, nil
}

func (store *FileAgentProfileStore) Load(threadID string) (AgentProfile, error) {
	if validateThreadID(threadID) != nil || store == nil || store.Path == "" {
		return AgentProfile{}, ErrInvalidRequest
	}
	file, err := store.read()
	if err != nil {
		return AgentProfile{}, err
	}
	profile, found := file.Profiles[threadID]
	if !found {
		return AgentProfile{}, ErrAgentProfileNotFound
	}
	if validateAgentProfile(profile) != nil {
		return AgentProfile{}, ErrInvalidAgentName
	}
	return profile, nil
}

func (store *FileAgentProfileStore) Save(threadID string, profile AgentProfile) error {
	if validateThreadID(threadID) != nil || validateAgentProfile(profile) != nil || store == nil || store.Path == "" {
		return ErrInvalidAgentName
	}
	file, err := store.read()
	if err != nil && !errors.Is(err, ErrAgentProfileNotFound) {
		return err
	}
	if file.Profiles == nil {
		file = agentProfileFile{Version: agentProfilesVersion, Profiles: map[string]AgentProfile{}}
	}
	file.Profiles[threadID] = profile
	body, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Project Chat profiles: %w", err)
	}
	directory := filepath.Dir(store.Path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create Project Chat profile directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".chat-agent-profiles-*")
	if err != nil {
		return fmt.Errorf("create Project Chat profile update: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure Project Chat profile update: %w", err)
	}
	if _, err := temporary.Write(append(body, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("write Project Chat profile update: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Project Chat profile update: %w", err)
	}
	if err := os.Rename(temporaryPath, store.Path); err != nil {
		return fmt.Errorf("save Project Chat profiles: %w", err)
	}
	return nil
}

func (store *FileAgentProfileStore) read() (agentProfileFile, error) {
	body, err := os.ReadFile(store.Path)
	if errors.Is(err, os.ErrNotExist) {
		return agentProfileFile{}, ErrAgentProfileNotFound
	}
	if err != nil {
		return agentProfileFile{}, fmt.Errorf("read Project Chat profiles: %w", err)
	}
	var file agentProfileFile
	if json.Unmarshal(body, &file) != nil || file.Version != agentProfilesVersion || file.Profiles == nil {
		return agentProfileFile{}, ErrInvalidResponse
	}
	return file, nil
}
