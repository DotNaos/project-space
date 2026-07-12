package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/projectchat"
)

func TestChatNamesPrintsGroupedRegistryState(t *testing.T) {
	catalog := testNameCatalog()
	catalog.Groups[0].Names = append(catalog.Groups[0].Names,
		projectchat.NameEntry{Name: "Nyx", Category: projectchat.NameCategoryMythology, State: "claimed", ClaimedByCurrentThread: true})
	command := newChatCommand(chatCommandDependencies{
		IdentityProvider: projectchat.ThreadIdentityProviderFunc(func(context.Context) (string, error) { return chatTestThreadID, nil }),
		Registry:         fakeNameRegistryClient{catalog: catalog},
	})
	output := &bytes.Buffer{}
	command.SetArgs([]string{"names"})
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"mythology:", "Athena", "available", "Nyx", "claimed by this thread"} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("output missing %q:\n%s", expected, output)
		}
	}
}

func TestChatClaimRequiresParentForSpecialist(t *testing.T) {
	catalog := projectchat.NameCatalog{Groups: []projectchat.NameGroup{{Category: projectchat.NameCategoryScience, Names: []projectchat.NameEntry{{Name: "Turing", Category: projectchat.NameCategoryScience, State: "available"}}}}}
	command := newChatCommand(chatCommandDependencies{
		IdentityProvider: projectchat.ThreadIdentityProviderFunc(func(context.Context) (string, error) { return chatTestThreadID, nil }),
		ProfileStore:     fixedAgentProfileStore{}, Registry: fakeNameRegistryClient{catalog: catalog},
	})
	command.SetArgs([]string{"claim", "Turing"})
	err := command.Execute()
	if !errors.Is(err, projectchat.ErrNameRoleForbidden) || !strings.Contains(err.Error(), "--parent-thread") {
		t.Fatalf("error = %v", err)
	}
}

func TestChatClaimDoesNotSaveWhenServerRejectsClaim(t *testing.T) {
	store := &recordingAgentProfileStore{}
	command := newChatCommand(chatCommandDependencies{
		IdentityProvider: projectchat.ThreadIdentityProviderFunc(func(context.Context) (string, error) { return chatTestThreadID, nil }),
		ProfileStore:     store, Registry: fakeNameRegistryClient{catalog: testNameCatalog(), err: projectchat.ErrNameConflict},
	})
	command.SetArgs([]string{"claim", "Athena"})
	err := command.Execute()
	if !errors.Is(err, projectchat.ErrNameConflict) || store.saved {
		t.Fatalf("error = %v, saved = %v", err, store.saved)
	}
}

func TestChatSendRejectsLegacyUnclaimedLocalProfile(t *testing.T) {
	command := newChatCommand(chatCommandDependencies{
		IdentityProvider: projectchat.ThreadIdentityProviderFunc(func(context.Context) (string, error) { return chatTestThreadID, nil }),
		ProfileStore:     fixedAgentProfileStore{profile: projectchat.AgentProfile{DisplayName: "Legacy"}}, Client: &fakeProjectChatClient{},
	})
	command.SetArgs([]string{"send", "hello"})
	if err := command.Execute(); !errors.Is(err, projectchat.ErrNameClaimRequired) {
		t.Fatalf("error = %v", err)
	}
}

func TestSpecialistClaimThenJoinUsesCanonicalCompositeDisplayName(t *testing.T) {
	parent := "019f49e1-cc3d-7243-bc12-75c74c786458"
	catalog := projectchat.NameCatalog{Groups: []projectchat.NameGroup{{Category: projectchat.NameCategoryScience, Names: []projectchat.NameEntry{{Name: "Turing", Category: projectchat.NameCategoryScience, State: "available"}}}}}
	store := &projectchat.FileAgentProfileStore{Path: t.TempDir() + "/profiles.json"}
	client := &fakeProjectChatClient{presenceError: projectchat.ErrNotRegistered, sendResult: chatTestMessage(1, "hello")}
	dependencies := chatTestDependencies(client)
	dependencies.ProfileStore = store
	dependencies.Registry = fakeNameRegistryClient{catalog: catalog, claim: projectchat.NameClaim{Name: "Turing", DisplayName: "Athena.Turing", Category: projectchat.NameCategoryScience, ThreadID: chatTestThreadID, ParentThreadID: parent}}

	claim := newChatCommand(dependencies)
	claim.SetArgs([]string{"claim", "Turing", "--parent-thread", parent})
	claim.SetOut(&bytes.Buffer{})
	claim.SetErr(&bytes.Buffer{})
	if err := claim.Execute(); err != nil {
		t.Fatalf("claim: %v", err)
	}

	send := newChatCommand(dependencies)
	send.SetArgs([]string{"send", "hello"})
	send.SetOut(&bytes.Buffer{})
	send.SetErr(&bytes.Buffer{})
	if err := send.Execute(); err != nil {
		t.Fatalf("send: %v", err)
	}
	if client.joinProfile.DisplayName != "Athena.Turing" || client.joinProfile.Category != projectchat.NameCategoryScience || client.joinProfile.ParentThreadID != parent {
		t.Fatalf("join profile = %#v", client.joinProfile)
	}
}

func TestLaterSuccessfulClaimOverwritesLocalCanonicalProfile(t *testing.T) {
	store := &projectchat.FileAgentProfileStore{Path: t.TempDir() + "/profiles.json"}
	dependencies := chatTestDependencies(&fakeProjectChatClient{})
	dependencies.ProfileStore = store
	dependencies.Registry = fakeNameRegistryClient{catalog: testNameCatalog(), claim: projectchat.NameClaim{Name: "Athena", DisplayName: "Athena", Category: projectchat.NameCategoryMythology, ThreadID: chatTestThreadID}}
	first := newChatCommand(dependencies)
	first.SetArgs([]string{"claim", "Athena"})
	first.SetOut(&bytes.Buffer{})
	first.SetErr(&bytes.Buffer{})
	if err := first.Execute(); err != nil {
		t.Fatal(err)
	}

	hermesCatalog := projectchat.NameCatalog{Groups: []projectchat.NameGroup{{Category: projectchat.NameCategoryMythology, Names: []projectchat.NameEntry{{Name: "Hermes", Category: projectchat.NameCategoryMythology, State: "available"}}}}}
	dependencies.Registry = fakeNameRegistryClient{catalog: hermesCatalog, claim: projectchat.NameClaim{Name: "Hermes", DisplayName: "Hermes", Category: projectchat.NameCategoryMythology, ThreadID: chatTestThreadID}}
	second := newChatCommand(dependencies)
	second.SetArgs([]string{"claim", "Hermes"})
	second.SetOut(&bytes.Buffer{})
	second.SetErr(&bytes.Buffer{})
	if err := second.Execute(); err != nil {
		t.Fatal(err)
	}
	profile, err := store.Load(chatTestThreadID)
	if err != nil || profile.DisplayName != "Hermes" {
		t.Fatalf("profile = %#v, %v", profile, err)
	}
}

type recordingAgentProfileStore struct{ saved bool }

func (*recordingAgentProfileStore) Load(string) (projectchat.AgentProfile, error) {
	return projectchat.AgentProfile{}, projectchat.ErrAgentProfileNotFound
}
func (store *recordingAgentProfileStore) Save(string, projectchat.AgentProfile) error {
	store.saved = true
	return nil
}
