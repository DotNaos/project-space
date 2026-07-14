package machineconnect

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

func decodeConnectorSupervisorJSON(body []byte, output any) error {
	if len(bytes.TrimSpace(body)) == 0 {
		return errors.New("JSON payload is empty")
	}
	if err := rejectConnectorSupervisorDuplicateJSONKeys(body); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return errors.New("JSON payload has an invalid shape")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON payload must contain exactly one value")
	}
	return nil
}

func rejectConnectorSupervisorDuplicateJSONKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := consumeConnectorSupervisorJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); err == nil || !errors.Is(err, io.EOF) {
		_ = token
		return errors.New("JSON payload must contain exactly one value")
	}
	return nil
}

func consumeConnectorSupervisorJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return errors.New("JSON payload is invalid")
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return errors.New("JSON object key is invalid")
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is invalid")
			}
			if _, duplicate := seen[key]; duplicate {
				return errors.New("JSON payload contains a duplicate key")
			}
			seen[key] = struct{}{}
			if err := consumeConnectorSupervisorJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim('}') {
			return errors.New("JSON object is incomplete")
		}
	case '[':
		for decoder.More() {
			if err := consumeConnectorSupervisorJSONValue(decoder); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil || closing != json.Delim(']') {
			return errors.New("JSON array is incomplete")
		}
	default:
		return errors.New("JSON delimiter is invalid")
	}
	return nil
}

func canonicalConnectorSupervisorJSON(raw []byte) ([]byte, error) {
	if err := rejectConnectorSupervisorDuplicateJSONKeys(raw); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("canonical JSON input is invalid")
	}
	var output strings.Builder
	if err := writeCanonicalConnectorSupervisorJSON(&output, value); err != nil {
		return nil, err
	}
	return []byte(output.String()), nil
}

func writeCanonicalConnectorSupervisorJSON(output *strings.Builder, value any) error {
	switch typed := value.(type) {
	case nil:
		output.WriteString("null")
	case bool:
		if typed {
			output.WriteString("true")
		} else {
			output.WriteString("false")
		}
	case string:
		encoded, _ := json.Marshal(typed)
		output.Write(encoded)
	case json.Number:
		integer, err := strconv.ParseInt(string(typed), 10, 64)
		if err != nil || integer > math.MaxInt64 || integer < -9_007_199_254_740_991 ||
			integer > 9_007_199_254_740_991 {
			return errors.New("canonical JSON accepts safe integers only")
		}
		output.WriteString(strconv.FormatInt(integer, 10))
	case []any:
		output.WriteByte('[')
		for index, entry := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeCanonicalConnectorSupervisorJSON(output, entry); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encodedKey, _ := json.Marshal(key)
			output.Write(encodedKey)
			output.WriteByte(':')
			if err := writeCanonicalConnectorSupervisorJSON(output, typed[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return fmt.Errorf("canonical JSON contains unsupported value %T", value)
	}
	return nil
}
