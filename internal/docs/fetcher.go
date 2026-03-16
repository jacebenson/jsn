// Package docs provides functionality for fetching and caching documentation from sn.jace.pro.
package docs

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// BaseURL is the base URL for sn.jace.pro documentation.
	BaseURL = "https://sn.jace.pro"
	// SearchIndexURL is the URL for the search index JSON.
	SearchIndexURL = "https://sn.jace.pro/core/assets/js/search_index.json"
	// CacheTTL is the time-to-live for cached files (24 hours).
	CacheTTL = 24 * time.Hour
)

// SearchIndexEntry represents a single entry in the search index.
type SearchIndexEntry struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Content     string `json:"content"`
}

// Fetcher handles fetching and caching documentation.
type Fetcher struct {
	cacheDir string
	client   *http.Client
}

// NewFetcher creates a new documentation fetcher.
func NewFetcher(cacheDir string) *Fetcher {
	if cacheDir == "" {
		// Use default cache location
		homeDir, _ := os.UserHomeDir()
		cacheDir = filepath.Join(homeDir, ".config", "servicenow", "docs")
	}

	return &Fetcher{
		cacheDir: cacheDir,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ensureCacheDir ensures the cache directory exists.
func (f *Fetcher) ensureCacheDir() error {
	return os.MkdirAll(f.cacheDir, 0755)
}

// getCachePath returns the cache file path for a given key.
func (f *Fetcher) getCachePath(key string) string {
	// Sanitize key to be a valid filename
	safeKey := strings.ReplaceAll(key, "/", "_")
	safeKey = strings.ReplaceAll(safeKey, ":", "_")
	return filepath.Join(f.cacheDir, safeKey)
}

// isCacheValid checks if a cached file is still valid (within TTL).
func (f *Fetcher) isCacheValid(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}

	return time.Since(info.ModTime()) < CacheTTL
}

// fetchFromCache reads data from cache if valid.
func (f *Fetcher) fetchFromCache(key string) ([]byte, bool) {
	path := f.getCachePath(key)

	if !f.isCacheValid(path) {
		return nil, false
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}

	return data, true
}

// saveToCache saves data to cache.
func (f *Fetcher) saveToCache(key string, data []byte) error {
	if err := f.ensureCacheDir(); err != nil {
		return err
	}

	path := f.getCachePath(key)
	return os.WriteFile(path, data, 0644)
}

// fetchFromURL fetches data from a URL.
func (f *Fetcher) fetchFromURL(url string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("User-Agent", "jsn-cli/1.0")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	return io.ReadAll(resp.Body)
}

// FetchSearchIndex fetches the search index from sn.jace.pro.
// It returns cached data if available and valid.
func (f *Fetcher) FetchSearchIndex(forceRefresh bool) ([]SearchIndexEntry, error) {
	cacheKey := "search_index.json"

	// Try cache first
	if !forceRefresh {
		if data, ok := f.fetchFromCache(cacheKey); ok {
			var entries []SearchIndexEntry
			if err := json.Unmarshal(data, &entries); err == nil {
				return entries, nil
			}
		}
	}

	// Fetch from network
	data, err := f.fetchFromURL(SearchIndexURL)
	if err != nil {
		// Try stale cache as fallback
		if staleData, ok := f.fetchFromCache(cacheKey); ok {
			var entries []SearchIndexEntry
			if err := json.Unmarshal(staleData, &entries); err == nil {
				return entries, fmt.Errorf("using stale cache: %w", err)
			}
		}
		return nil, err
	}

	// Parse JSON
	var entries []SearchIndexEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("parsing search index: %w", err)
	}

	// Save to cache
	if err := f.saveToCache(cacheKey, data); err != nil {
		// Non-fatal: just log and continue
		fmt.Fprintf(os.Stderr, "Warning: failed to cache search index: %v\n", err)
	}

	return entries, nil
}

// FetchDoc fetches a specific documentation page by topic.
// Topics are mapped to URLs like https://sn.jace.pro/docs/{topic}.md
func (f *Fetcher) FetchDoc(topic string, forceRefresh bool) ([]byte, error) {
	cacheKey := fmt.Sprintf("doc_%s.md", topic)
	url := fmt.Sprintf("%s/docs/%s.md", BaseURL, topic)

	// Try cache first
	if !forceRefresh {
		if data, ok := f.fetchFromCache(cacheKey); ok {
			return data, nil
		}
	}

	// Fetch from network
	data, err := f.fetchFromURL(url)
	if err != nil {
		// Try stale cache as fallback
		if staleData, ok := f.fetchFromCache(cacheKey); ok {
			return staleData, fmt.Errorf("using stale cache: %w", err)
		}
		return nil, err
	}

	// Save to cache
	if err := f.saveToCache(cacheKey, data); err != nil {
		// Non-fatal
		fmt.Fprintf(os.Stderr, "Warning: failed to cache doc %s: %v\n", topic, err)
	}

	return data, nil
}

// ClearCache clears all cached documentation.
func (f *Fetcher) ClearCache() error {
	return os.RemoveAll(f.cacheDir)
}

// GetCacheInfo returns information about the cache.
func (f *Fetcher) GetCacheInfo() (map[string]time.Time, error) {
	info := make(map[string]time.Time)

	entries, err := os.ReadDir(f.cacheDir)
	if err != nil {
		if os.IsNotExist(err) {
			return info, nil
		}
		return nil, err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		path := filepath.Join(f.cacheDir, entry.Name())
		stat, err := os.Stat(path)
		if err != nil {
			continue
		}

		info[entry.Name()] = stat.ModTime()
	}

	return info, nil
}

// IsCached checks if a specific item is cached and valid.
func (f *Fetcher) IsCached(key string) bool {
	path := f.getCachePath(key)
	return f.isCacheValid(path)
}
