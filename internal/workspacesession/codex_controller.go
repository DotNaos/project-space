package workspacesession

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type codexControllerReady struct {
	AcceptedCommandSequence int64  `json:"acceptedCommandSequence"`
	Capability              string `json:"capability"`
	LastEventSequence       int64  `json:"lastEventSequence"`
	State                   string `json:"state"`
	Type                    string `json:"type"`
}

type codexController struct {
	command  *exec.Cmd
	input    io.WriteCloser
	messages chan json.RawMessage
	errors   chan error
	ready    codexControllerReady
	readyMu  sync.RWMutex
	stopping chan struct{}
	stopOnce sync.Once
}

func startCodexController(ctx context.Context, bootstrap Bootstrap) (*codexController, error) {
	if !hasCapability(bootstrap.RequestedCapabilities, "runtime.codex.v1") {
		return nil, nil
	}
	if !filepath.IsAbs(bootstrap.CodexControllerBinary) ||
		!filepath.IsAbs(bootstrap.CodexControllerBootstrap) {
		return nil, fmt.Errorf("Workspace Runtime Codex controller path is invalid")
	}
	for _, path := range []string{bootstrap.CodexControllerBinary, bootstrap.CodexControllerBootstrap} {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("Workspace Runtime Codex controller file is invalid")
		}
	}
	command := exec.CommandContext(ctx, bootstrap.CodexControllerBinary,
		"workspace-codex-host", "--bootstrap", bootstrap.CodexControllerBootstrap)
	generationHome := filepath.Dir(bootstrap.CodexControllerBootstrap)
	command.Env = []string{
		"HOME=" + filepath.Join(generationHome, "home"),
		"XDG_CONFIG_HOME=" + filepath.Join(generationHome, "config"),
		"XDG_DATA_HOME=" + filepath.Join(generationHome, "data"),
		"XDG_CACHE_HOME=" + filepath.Join(generationHome, "cache"),
		"CODEX_HOME=" + filepath.Join(generationHome, "codex"),
	}
	input, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		input.Close()
		return nil, err
	}
	controller := &codexController{
		command: command, input: input, messages: make(chan json.RawMessage, 64),
		errors: make(chan error, 1), stopping: make(chan struct{}),
	}
	scanner := bufio.NewScanner(io.LimitReader(output, 8*1024*1024))
	scanner.Buffer(make([]byte, 4096), 64*1024)
	if !scanner.Scan() {
		controller.stop()
		return nil, fmt.Errorf("Workspace Runtime Codex controller did not become ready")
	}
	if json.Unmarshal(scanner.Bytes(), &controller.ready) != nil || controller.ready.Type != "controller.ready" ||
		controller.ready.State != "ready" || controller.ready.Capability != "runtime.codex.v1" ||
		controller.ready.AcceptedCommandSequence < 0 || controller.ready.LastEventSequence < 0 {
		controller.stop()
		return nil, fmt.Errorf("Workspace Runtime Codex controller readiness is invalid")
	}
	go func() {
		defer close(controller.messages)
		for scanner.Scan() {
			encoded := append(json.RawMessage(nil), scanner.Bytes()...)
			controller.observeMessage(encoded)
			select {
			case controller.messages <- encoded:
			case <-controller.stopping:
				return
			}
		}
		if err := scanner.Err(); err != nil {
			controller.errors <- err
		}
		close(controller.errors)
	}()
	return controller, nil
}

func (controller *codexController) watermarks() (int64, int64) {
	controller.readyMu.RLock()
	defer controller.readyMu.RUnlock()
	return controller.ready.AcceptedCommandSequence, controller.ready.LastEventSequence
}

func (controller *codexController) observeMessage(encoded json.RawMessage) {
	var envelope struct {
		Type    string `json:"type"`
		Message struct {
			CommandSequence int64  `json:"commandSequence"`
			EventSequence   *int64 `json:"eventSequence,omitempty"`
			Type            string `json:"type"`
		} `json:"message"`
	}
	if json.Unmarshal(encoded, &envelope) != nil || envelope.Type != "controller.message" ||
		envelope.Message.CommandSequence < 1 {
		return
	}
	switch envelope.Message.Type {
	case "runtime.codex.command-accepted", "runtime.codex.result", "runtime.codex.error":
		if envelope.Message.EventSequence != nil {
			return
		}
	case "runtime.codex.event":
		if envelope.Message.EventSequence == nil || *envelope.Message.EventSequence < 1 {
			return
		}
	default:
		return
	}
	controller.readyMu.Lock()
	defer controller.readyMu.Unlock()
	if envelope.Message.Type == "runtime.codex.command-accepted" &&
		envelope.Message.CommandSequence > controller.ready.AcceptedCommandSequence {
		controller.ready.AcceptedCommandSequence = envelope.Message.CommandSequence
	}
	if envelope.Message.EventSequence != nil && *envelope.Message.EventSequence > controller.ready.LastEventSequence {
		controller.ready.LastEventSequence = *envelope.Message.EventSequence
	}
}

func (controller *codexController) write(value interface{}) error {
	if controller == nil {
		return fmt.Errorf("Workspace Runtime Codex controller is unavailable")
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(encoded) > 64*1024 {
		return fmt.Errorf("Workspace Runtime Codex controller message is too large")
	}
	encoded = append(encoded, '\n')
	_, err = controller.input.Write(encoded)
	return err
}

func (controller *codexController) bind(sessionID string, resumeAfterEventSequence int64) error {
	return controller.write(map[string]interface{}{
		"type": "controller.bind", "sessionId": sessionID,
		"resumeAfterEventSequence": resumeAfterEventSequence,
	})
}

func (controller *codexController) commandMessage(command json.RawMessage) error {
	return controller.write(map[string]interface{}{"type": "controller.command", "command": command})
}

func (controller *codexController) stop() {
	if controller == nil {
		return
	}
	controller.stopOnce.Do(func() {
		close(controller.stopping)
		_ = controller.write(map[string]string{"type": "controller.stop"})
		_ = controller.input.Close()
		done := make(chan struct{})
		go func() { _ = controller.command.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = controller.command.Process.Kill()
			select {
			case <-done:
			case <-time.After(time.Second):
			}
		}
	})
}
