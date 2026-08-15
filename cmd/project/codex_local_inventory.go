package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

const localCodexInventoryTimeout = 20 * time.Second

type localCodexThread struct {
	CWD string `json:"cwd"`
	ID  string `json:"id"`
}

type codexRPCResponse struct {
	Error  json.RawMessage `json:"error"`
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
}

type codexThreadPage struct {
	Data       []localCodexThread `json:"data"`
	NextCursor *string            `json:"nextCursor"`
}

func listLocalCodexThreads(ctx context.Context) ([]localCodexThread, error) {
	requestContext, cancel := context.WithTimeout(ctx, localCodexInventoryTimeout)
	defer cancel()
	binary, err := resolveCodexBinary(requestContext, "")
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(requestContext, binary, "app-server", "--listen", "stdio://")
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, errors.New("open Codex app-server input")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, errors.New("open Codex app-server output")
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return nil, errors.New("start local Codex app-server")
	}
	defer func() {
		_ = stdin.Close()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	if err := writeCodexRPC(stdin, 1, "initialize", map[string]any{
		"capabilities": map[string]any{"experimentalApi": false, "requestAttestation": false},
		"clientInfo": map[string]string{"name": "project-space", "title": "Project Space", "version": projectMachineClientVersion},
	}); err != nil {
		return nil, err
	}
	if _, err := readCodexRPCResponse(scanner, 1); err != nil {
		return nil, fmt.Errorf("initialize local Codex inventory: %w", err)
	}
	if err := writeCodexRPCNotification(stdin, "initialized", nil); err != nil {
		return nil, err
	}
	threads := make([]localCodexThread, 0)
	seenCursors := map[string]bool{}
	var cursor *string
	requestID := 2
	for {
		params := map[string]any{
			"archived": false, "limit": 100,
			"sortDirection": "desc", "sortKey": "updated_at",
		}
		if cursor != nil {
			params["cursor"] = *cursor
		}
		if err := writeCodexRPC(stdin, requestID, "thread/list", params); err != nil {
			return nil, err
		}
		result, err := readCodexRPCResponse(scanner, requestID)
		if err != nil {
			return nil, fmt.Errorf("list local Codex tasks: %w", err)
		}
		page := codexThreadPage{}
		if err := json.Unmarshal(result, &page); err != nil || page.Data == nil {
			return nil, errors.New("local Codex task inventory is invalid")
		}
		threads = append(threads, page.Data...)
		if len(threads) > 10_000 {
			return nil, errors.New("local Codex task inventory exceeds the safety limit")
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return threads, nil
		}
		if seenCursors[*page.NextCursor] {
			return nil, errors.New("local Codex task inventory repeated a cursor")
		}
		seenCursors[*page.NextCursor] = true
		cursor = page.NextCursor
		requestID++
	}
}

func writeCodexRPC(writer io.Writer, id int, method string, params any) error {
	return json.NewEncoder(writer).Encode(map[string]any{"id": id, "method": method, "params": params})
}

func writeCodexRPCNotification(writer io.Writer, method string, params any) error {
	return json.NewEncoder(writer).Encode(map[string]any{"method": method, "params": params})
}

func readCodexRPCResponse(scanner *bufio.Scanner, id int) (json.RawMessage, error) {
	for scanner.Scan() {
		response := codexRPCResponse{}
		if json.Unmarshal(scanner.Bytes(), &response) != nil || response.ID != id {
			continue
		}
		if len(response.Error) != 0 && string(response.Error) != "null" {
			return nil, errors.New("Codex app-server rejected the inventory request")
		}
		if len(response.Result) == 0 {
			return nil, errors.New("Codex app-server returned no inventory result")
		}
		return response.Result, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, errors.New("read local Codex task inventory")
	}
	return nil, errors.New("local Codex app-server closed before returning task inventory")
}
