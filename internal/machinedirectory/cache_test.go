package machinedirectory

import (
	"errors"
	"testing"
	"time"
)

func TestCompletionCacheIsScopedAndExpires(t *testing.T) {
	now := time.Date(2026, 7, 28, 16, 0, 0, 0, time.UTC)
	cache := Cache{Directory: t.TempDir(), Now: func() time.Time { return now }}
	result := MachinesResult{
		CheckedAt:     "2026-07-28T16:00:00Z",
		Failures:      []Failure{},
		Machines:      []Machine{},
		SchemaVersion: 1,
	}
	key := CacheKey("https://projects.example", "machine", "token", "machines")
	other := CacheKey("https://projects.example", "machine", "other-token", "machines")
	if err := cache.WriteMachines(key, result); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.ReadMachines(other, time.Minute); !errors.Is(err, ErrCacheMiss) {
		t.Fatalf("other credential error = %v", err)
	}
	now = now.Add(61 * time.Second)
	if _, err := cache.ReadMachines(key, time.Minute); !errors.Is(err, ErrCacheExpired) {
		t.Fatalf("expired error = %v", err)
	}
}
