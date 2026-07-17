package codextask

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

const maximumSSEEventBytes = 256 * 1024

type SubscribeRequest struct {
	ReadRequest
	AfterSequence uint64
	OnOpen        func()
}

type EventHandler func(ProgressEvent) error

func (client *Client) Stream(ctx context.Context, request SubscribeRequest, handle EventHandler) error {
	if err := validateReadRequest(request.ReadRequest); err != nil || handle == nil {
		return ErrInvalidInput
	}
	endpoint := path.Join(tasksPath, request.ThreadID, "stream")
	httpRequest, err := client.newRequest(
		ctx,
		http.MethodGet,
		endpoint,
		selectorQuery(request.Selector),
		"",
		"text/event-stream",
		nil,
	)
	if err != nil {
		return err
	}
	if request.AfterSequence > 0 {
		httpRequest.Header.Set("Last-Event-ID", strconv.FormatUint(request.AfterSequence, 10))
	}
	response, err := client.streamHTTPClient.Do(httpRequest)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return ErrRedirectRejected
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, readErr := readBounded(response.Body, client.maximumResponse)
		if readErr != nil {
			return readErr
		}
		return requestError(response.StatusCode, body)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		return ErrInvalidResponse
	}
	if request.OnOpen != nil {
		request.OnOpen()
	}
	return readSSE(ctx, response.Body, request.AfterSequence, func(event ProgressEvent) error {
		if event.Result != nil {
			if err := validateStreamResult(*event.Result, request.ReadRequest); err != nil {
				return err
			}
		}
		return handle(event)
	})
}

func validateStreamResult(result SendResult, request ReadRequest) error {
	switch result.State {
	case StateAccepted:
		if result.Target == nil || validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector) ||
			result.ThreadID != request.ThreadID || result.TurnID == "" || result.Result != nil {
			return ErrInvalidResponse
		}
	case StateCompleted:
		if result.Target == nil || validateTarget(*result.Target) != nil ||
			!targetMatchesSelector(*result.Target, request.Selector) ||
			result.ThreadID != request.ThreadID || result.TurnID == "" || result.Result == nil ||
			!result.Result.OpenedReadOnly || result.Result.Session.ID != request.ThreadID ||
			result.Result.Session.MachineID != result.Target.Connector.ID || result.Result.Turns == nil {
			return ErrInvalidResponse
		}
	case StateBlocked, StateUncertain:
		if !validText(result.Message, 2_048) || result.Result != nil {
			return ErrInvalidResponse
		}
	default:
		return ErrInvalidResponse
	}
	return nil
}

func readSSE(ctx context.Context, input io.Reader, after uint64, handle EventHandler) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), maximumSSEEventBytes)
	current := sseRecord{}
	lastSequence := after
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			terminal, err := dispatchSSE(current, &lastSequence, handle)
			if err != nil {
				return err
			}
			if terminal {
				return nil
			}
			current = sseRecord{}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			field, value = line, ""
		} else {
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "id":
			current.id = value
		case "event":
			current.event = value
		case "data":
			if current.data.Len()+len(value)+1 > maximumSSEEventBytes {
				return ErrResponseTooLarge
			}
			if current.data.Len() > 0 {
				current.data.WriteByte('\n')
			}
			current.data.WriteString(value)
		case "retry":
		default:
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return ErrResponseTooLarge
		}
		return ErrInvalidResponse
	}
	if current.id != "" || current.data.Len() > 0 {
		terminal, err := dispatchSSE(current, &lastSequence, handle)
		if err != nil {
			return err
		}
		if terminal {
			return nil
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

type sseRecord struct {
	data  strings.Builder
	event string
	id    string
}

func dispatchSSE(record sseRecord, lastSequence *uint64, handle EventHandler) (bool, error) {
	if record.id == "" && record.data.Len() == 0 {
		return false, nil
	}
	sequence, err := strconv.ParseUint(record.id, 10, 64)
	if err != nil || sequence <= *lastSequence || record.data.Len() == 0 {
		return false, ErrInvalidResponse
	}
	event := ProgressEvent{}
	raw := []byte(record.data.String())
	rawProgress := false
	if json.Unmarshal(raw, &event) != nil {
		return false, ErrInvalidResponse
	}
	if event.Type != "progress" && event.Type != "result" {
		if record.event != "progress" {
			return false, ErrInvalidResponse
		}
		sessionEvent := SessionStreamEvent{}
		if json.Unmarshal(raw, &sessionEvent) != nil {
			return false, ErrInvalidResponse
		}
		sessionEvent.Raw = append(json.RawMessage(nil), raw...)
		event = ProgressEvent{
			APIVersion: APIVersion,
			Event:      &sessionEvent,
			Type:       "progress",
		}
		rawProgress = true
	} else if record.event != "" && event.Type != record.event {
		return false, ErrInvalidResponse
	}
	if event.Event != nil && !rawProgress {
		envelope := struct {
			Event json.RawMessage `json:"event"`
		}{}
		if json.Unmarshal(raw, &envelope) != nil || len(envelope.Event) == 0 {
			return false, ErrInvalidResponse
		}
		event.Event.Raw = append(json.RawMessage(nil), envelope.Event...)
	}
	if err := validateProgressEvent(&event, sequence); err != nil {
		return false, err
	}
	*lastSequence = sequence
	if err := handle(event); err != nil {
		return false, err
	}
	return event.Type == "result", nil
}

func validateProgressEvent(event *ProgressEvent, sequence uint64) error {
	switch event.Type {
	case "progress":
		if event.APIVersion != APIVersion || event.Event == nil || event.Result != nil ||
			event.Event.EventID == "" || event.Event.Type == "" {
			return ErrInvalidResponse
		}
		if event.Sequence != nil && *event.Sequence != sequence {
			return ErrInvalidResponse
		}
		event.Sequence = &sequence
	case "result":
		if event.Result == nil || event.Event != nil ||
			validateCommonResult(event.Result.APIVersion, event.Result.OperationID, event.Result.State, event.Result.Reason, event.Result.Reconcile) != nil {
			return ErrInvalidResponse
		}
	default:
		return ErrInvalidResponse
	}
	return nil
}
