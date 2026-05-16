package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

func Serve(version string) error {
	reader := bufio.NewReader(os.Stdin)
	for {
		body, err := readFramed(reader)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			writeFramed(map[string]any{"jsonrpc": "2.0", "error": map[string]any{"code": -32700, "message": err.Error()}})
			continue
		}
		var message map[string]any
		if err := json.Unmarshal(body, &message); err != nil {
			writeFramed(map[string]any{"jsonrpc": "2.0", "error": map[string]any{"code": -32700, "message": err.Error()}})
			continue
		}
		handle(message, version)
	}
}

func handle(message map[string]any, version string) {
	id := message["id"]
	switch message["method"] {
	case "initialize":
		writeFramed(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
			"protocolVersion": "2025-03-26",
			"serverInfo":      map[string]any{"name": "project-space", "version": version},
			"capabilities":    map[string]any{"tools": map[string]any{}},
		}})
	case "tools/list":
		writeFramed(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"tools": []map[string]any{{
			"name":        "project_space_status",
			"description": "Return Project Space runtime status.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		}}}})
	case "tools/call":
		writeFramed(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"content": []map[string]any{{
			"type": "text",
			"text": "Project Space runtime " + version + " is available.",
		}}}})
	default:
		writeFramed(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "method not found"}})
	}
}

func readFramed(reader *bufio.Reader) ([]byte, error) {
	length := 0
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		key, value, ok := strings.Cut(line, ":")
		if ok && strings.EqualFold(key, "Content-Length") {
			parsed, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, err
			}
			length = parsed
		}
	}
	if length == 0 {
		return nil, fmt.Errorf("missing content length")
	}
	body := make([]byte, length)
	_, err := io.ReadFull(reader, body)
	return body, err
}

func writeFramed(message map[string]any) {
	body, _ := json.Marshal(message)
	fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n", len(body))
	_, _ = os.Stdout.Write(body)
}
