package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"testing"
)

func TestReadCodexRPCResponseSkipsNotificationsAndOtherRequests(t *testing.T) {
	input := bytes.NewBufferString(
		"{\"method\":\"thread/updated\",\"params\":{}}\n" +
			"{\"id\":1,\"result\":{}}\n" +
			"{\"id\":2,\"result\":{\"data\":[],\"nextCursor\":null}}\n",
	)
	result, err := readCodexRPCResponse(bufio.NewScanner(input), 2)
	if err != nil {
		t.Fatal(err)
	}
	page := codexThreadPage{}
	if err := json.Unmarshal(result, &page); err != nil || page.Data == nil || page.NextCursor != nil {
		t.Fatalf("page = %#v err=%v", page, err)
	}
}

func TestReadCodexRPCResponseRejectsProtocolError(t *testing.T) {
	input := bytes.NewBufferString("{\"id\":1,\"error\":{\"code\":-32600}}\n")
	if _, err := readCodexRPCResponse(bufio.NewScanner(input), 1); err == nil {
		t.Fatal("RPC error was accepted")
	}
}
