package projectcatalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

var (
	ErrCacheExpired = errors.New("project catalog cache expired")
	ErrCacheMiss    = errors.New("project catalog cache is unavailable")
)

type Cache struct {
	Directory string
	Now       func() time.Time
}

type cacheRecord struct {
	Catalog  Catalog   `json:"catalog"`
	StoredAt time.Time `json:"storedAt"`
}

func CacheKey(baseURL, machineID, token string) string {
	sum := sha256.Sum256([]byte(baseURL + "\x00" + machineID + "\x00" + token))
	return hex.EncodeToString(sum[:])
}

func (cache Cache) Read(key string, maximumAge time.Duration) (Catalog, error) {
	if cache.Directory == "" || key == "" || maximumAge <= 0 {
		return Catalog{}, ErrCacheMiss
	}
	file, err := os.Open(filepath.Join(cache.Directory, key+".json"))
	if os.IsNotExist(err) {
		return Catalog{}, ErrCacheMiss
	}
	if err != nil {
		return Catalog{}, ErrInvalidResponse
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > maximumResponseBytes {
		return Catalog{}, ErrInvalidResponse
	}
	decoder := json.NewDecoder(io.LimitReader(file, maximumResponseBytes+1))
	decoder.DisallowUnknownFields()
	var record cacheRecord
	if err := decoder.Decode(&record); err != nil {
		return Catalog{}, ErrInvalidResponse
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return Catalog{}, ErrInvalidResponse
	}
	now := time.Now
	if cache.Now != nil {
		now = cache.Now
	}
	if record.StoredAt.IsZero() || now().Sub(record.StoredAt) < 0 ||
		now().Sub(record.StoredAt) > maximumAge {
		return Catalog{}, ErrCacheExpired
	}
	if err := validateCatalog(&record.Catalog); err != nil {
		return Catalog{}, err
	}
	return record.Catalog, nil
}

func (cache Cache) Write(key string, catalog Catalog) error {
	if cache.Directory == "" || key == "" {
		return ErrCacheMiss
	}
	if err := validateCatalog(&catalog); err != nil {
		return err
	}
	if err := os.MkdirAll(cache.Directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(cache.Directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(cache.Directory, ".project-catalog-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	now := time.Now
	if cache.Now != nil {
		now = cache.Now
	}
	encoder := json.NewEncoder(temporary)
	if err := encoder.Encode(cacheRecord{Catalog: catalog, StoredAt: now()}); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, filepath.Join(cache.Directory, key+".json"))
}
