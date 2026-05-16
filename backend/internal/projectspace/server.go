package projectspace

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func Serve(version string) error {
	loadEnv()
	host := getenv("PROJECT_SPACE_HOST", "127.0.0.1")
	port := getenv("PROJECT_SPACE_PORT", "4173")
	root := repoRoot()

	mux := http.NewServeMux()
	registerAPI(mux, version)

	staticRoot := filepath.Join(root, "apps", "web", "dist")
	if _, err := os.Stat(filepath.Join(staticRoot, "index.html")); err == nil {
		mux.Handle("/", spaFileServer(staticRoot))
	} else {
		mux.HandleFunc("/", func(response http.ResponseWriter, request *http.Request) {
			writeJSON(response, http.StatusNotFound, map[string]any{
				"error": "web app not built; run bun run web:build",
			})
		})
	}

	address := host + ":" + port
	fmt.Printf("Project Space runtime listening on http://%s\n", address)
	return http.ListenAndServe(address, mux)
}

func Health() error {
	loadEnv()
	host := getenv("PROJECT_SPACE_HOST", "127.0.0.1")
	port := getenv("PROJECT_SPACE_PORT", "4173")
	response, err := http.Get("http://" + host + ":" + port + "/api/health")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("health returned %s", response.Status)
	}
	fmt.Println("ok")
	return nil
}

func spaFileServer(root string) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		path := strings.TrimPrefix(filepath.Clean(request.URL.Path), string(filepath.Separator))
		target := filepath.Join(root, path)
		if path == "." || path == "" {
			target = filepath.Join(root, "index.html")
		}
		if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
			target = filepath.Join(root, "index.html")
		}
		http.ServeFile(response, request, target)
	})
}
