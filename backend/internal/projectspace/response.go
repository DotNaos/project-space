package projectspace

import (
	"encoding/json"
	"net/http"
)

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	response.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
	response.Header().Set("Access-Control-Allow-Origin", "*")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func readJSON[T any](request *http.Request) (T, error) {
	var value T
	err := json.NewDecoder(request.Body).Decode(&value)
	return value, err
}

func apiError(response http.ResponseWriter, status int, err error) {
	writeJSON(response, status, map[string]any{"error": err.Error()})
}
