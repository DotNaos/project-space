package projectcatalog

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCompletionCacheIsScopedBoundedAndShortLived(t *testing.T) {
	now := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	cache := Cache{Directory: t.TempDir(), Now: func() time.Time { return now }}
	key := CacheKey("https://projects.example", "machine-one", "token-one")
	catalog := testCatalog()
	if err := cache.Write(key, catalog); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(filepath.Join(cache.Directory, key+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("cache permissions = %o", info.Mode().Perm())
	}
	got, err := cache.Read(key, time.Minute)
	if err != nil || len(got.Projects) != len(catalog.Projects) {
		t.Fatalf("read = %#v, %v", got, err)
	}
	if _, err := cache.Read(
		CacheKey("https://projects.example", "machine-one", "token-two"),
		time.Minute,
	); !errors.Is(err, ErrCacheMiss) {
		t.Fatalf("wrong-scope error = %v", err)
	}
	now = now.Add(time.Minute + time.Nanosecond)
	if _, err := cache.Read(key, time.Minute); !errors.Is(err, ErrCacheExpired) {
		t.Fatalf("expired error = %v", err)
	}
}

func TestCompletionCacheRejectsCorruptAndOversizedFiles(t *testing.T) {
	cache := Cache{Directory: t.TempDir(), Now: time.Now}
	key := CacheKey("https://projects.example", "machine-one", "token-one")
	path := filepath.Join(cache.Directory, key+".json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Read(key, time.Minute); !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("corrupt error = %v", err)
	}
	if err := os.WriteFile(path, make([]byte, maximumResponseBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Read(key, time.Minute); !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("oversized error = %v", err)
	}
}
