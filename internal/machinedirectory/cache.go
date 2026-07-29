package machinedirectory

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
	ErrCacheExpired = errors.New("machine directory cache expired")
	ErrCacheMiss    = errors.New("machine directory cache is unavailable")
)

type Cache struct {
	Directory string
	Now       func() time.Time
}

type machineCacheRecord struct {
	Result   MachinesResult `json:"result"`
	StoredAt time.Time      `json:"storedAt"`
}

type threadCacheRecord struct {
	Result   ThreadsResult `json:"result"`
	StoredAt time.Time     `json:"storedAt"`
}

func CacheKey(baseURL, machineID, token, scope string) string {
	sum := sha256.Sum256([]byte(baseURL + "\x00" + machineID + "\x00" + token + "\x00" + scope))
	return hex.EncodeToString(sum[:])
}

func (cache Cache) ReadMachines(key string, maximumAge time.Duration) (MachinesResult, error) {
	var record machineCacheRecord
	if err := cache.read(key, maximumAge, &record, &record.StoredAt); err != nil {
		return MachinesResult{}, err
	}
	if err := validateMachines(&record.Result); err != nil {
		return MachinesResult{}, err
	}
	return record.Result, nil
}

func (cache Cache) WriteMachines(key string, result MachinesResult) error {
	if err := validateMachines(&result); err != nil {
		return err
	}
	return cache.write(key, machineCacheRecord{Result: result, StoredAt: cache.now()})
}

func (cache Cache) ReadThreads(key string, maximumAge time.Duration) (ThreadsResult, error) {
	var record threadCacheRecord
	if err := cache.read(key, maximumAge, &record, &record.StoredAt); err != nil {
		return ThreadsResult{}, err
	}
	if err := validateThreads(&record.Result); err != nil {
		return ThreadsResult{}, err
	}
	return record.Result, nil
}

func (cache Cache) WriteThreads(key string, result ThreadsResult) error {
	if err := validateThreads(&result); err != nil {
		return err
	}
	return cache.write(key, threadCacheRecord{Result: result, StoredAt: cache.now()})
}

func (cache Cache) read(
	key string,
	maximumAge time.Duration,
	destination any,
	storedAt *time.Time,
) error {
	if cache.Directory == "" || key == "" || maximumAge <= 0 {
		return ErrCacheMiss
	}
	file, err := os.Open(filepath.Join(cache.Directory, key+".json"))
	if os.IsNotExist(err) {
		return ErrCacheMiss
	}
	if err != nil {
		return ErrInvalidResponse
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > maximumResponseBytes {
		return ErrInvalidResponse
	}
	decoder := json.NewDecoder(io.LimitReader(file, maximumResponseBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return ErrInvalidResponse
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return ErrInvalidResponse
	}
	age := cache.now().Sub(*storedAt)
	if storedAt.IsZero() || age < 0 || age > maximumAge {
		return ErrCacheExpired
	}
	return nil
}

func (cache Cache) write(key string, value any) error {
	if cache.Directory == "" || key == "" {
		return ErrCacheMiss
	}
	if err := os.MkdirAll(cache.Directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(cache.Directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(cache.Directory, ".machine-directory-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := json.NewEncoder(temporary).Encode(value); err != nil {
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

func (cache Cache) now() time.Time {
	if cache.Now != nil {
		return cache.Now()
	}
	return time.Now()
}
