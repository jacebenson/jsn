// Package tui provides terminal UI components for interactive selection.
package tui

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/jacebenson/jsn/internal/appctx"
)

// ListFetcher creates a fetcher for the interactive list picker.
// This handles pagination, search-as-you-type, and result formatting.
type ListFetcher struct {
	Table      string
	BaseQuery  string
	Columns    []string
	OrderBy    string
	FormatItem func(record map[string]any) PickerItem
}

// NewListFetcher creates a new list fetcher with defaults.
func NewListFetcher(table string) *ListFetcher {
	return &ListFetcher{
		Table:   table,
		OrderBy: "ORDERBYDESCsys_updated_on",
		Columns: []string{"sys_id"},
		FormatItem: func(record map[string]any) PickerItem {
			// Default format: use sys_id as ID, first column as title
			sysID := getStringValue(record, "sys_id")
			title := sysID
			for _, col := range record {
				if s, ok := col.(string); ok && s != "" && s != sysID {
					title = s
					break
				}
			}
			return PickerItem{
				ID:    sysID,
				Title: title,
			}
		},
	}
}

// WithColumns sets the columns to fetch.
func (f *ListFetcher) WithColumns(cols ...string) *ListFetcher {
	f.Columns = append([]string{"sys_id"}, cols...)
	return f
}

// WithBaseQuery sets a base query that's always applied.
func (f *ListFetcher) WithBaseQuery(query string) *ListFetcher {
	f.BaseQuery = query
	return f
}

// WithOrderBy sets the sort order (default: ORDERBYDESCsys_updated_on).
func (f *ListFetcher) WithOrderBy(order string) *ListFetcher {
	f.OrderBy = order
	return f
}

// WithFormatItem sets a custom item formatter.
func (f *ListFetcher) WithFormatItem(formatter func(record map[string]any) PickerItem) *ListFetcher {
	f.FormatItem = formatter
	return f
}

// Build creates the QueryablePageFetcher function.
func (f *ListFetcher) Build(app *appctx.App) QueryablePageFetcher {
	return func(ctx context.Context, offset, limit int, searchQuery string) (*PageResult, error) {
		params := url.Values{}
		params.Set("sysparm_limit", fmt.Sprintf("%d", limit))
		params.Set("sysparm_offset", fmt.Sprintf("%d", offset))
		params.Set("sysparm_display_value", "all")
		params.Set("sysparm_fields", strings.Join(f.Columns, ","))

		// Build the query
		query := f.BaseQuery
		if searchQuery != "" {
			// Default search: look in all string columns
			// Override this by setting a custom search query builder
			searchPart := buildDefaultSearch(f.Columns, searchQuery)
			if query != "" {
				query = query + "^" + searchPart
			} else {
				query = searchPart
			}
		}

		// Add ordering
		if query != "" {
			params.Set("sysparm_query", query+"^"+f.OrderBy)
		} else {
			params.Set("sysparm_query", f.OrderBy)
		}

		records, err := app.SDK.List(ctx, f.Table, params)
		if err != nil {
			return nil, err
		}

		// Convert records to picker items
		items := make([]PickerItem, len(records))
		for i, record := range records {
			items[i] = f.FormatItem(record)
		}

		// Get total count
		totalCount := -1
		countQuery := query
		if countQuery == "" {
			countQuery = f.OrderBy
		}
		count, err := app.SDK.AggregateCount(ctx, f.Table, countQuery)
		if err == nil {
			totalCount = count
		}

		return &PageResult{
			Items:      items,
			HasMore:    len(records) == limit,
			TotalCount: totalCount,
		}, nil
	}
}

// buildDefaultSearch creates a search query for string columns.
func buildDefaultSearch(columns []string, search string) string {
	// Search in name/number fields by default
	var searchFields []string
	for _, col := range columns {
		if col == "number" || col == "name" || col == "short_description" ||
			col == "title" || col == "description" || strings.HasSuffix(col, "_name") {
			searchFields = append(searchFields, col+"LIKE"+search)
		}
	}
	if len(searchFields) == 0 && len(columns) > 0 {
		// Fallback to first non-sys_id column
		for _, col := range columns {
			if col != "sys_id" {
				searchFields = append(searchFields, col+"LIKE"+search)
				break
			}
		}
	}
	return strings.Join(searchFields, "^OR")
}

// getStringValue extracts a string value from a record, handling reference fields.
func getStringValue(record map[string]any, key string) string {
	if v, ok := record[key]; ok && v != nil {
		switch val := v.(type) {
		case string:
			return val
		case map[string]any:
			if display, ok := val["display_value"].(string); ok && display != "" {
				return display
			}
			if value, ok := val["value"].(string); ok {
				return value
			}
		}
	}
	return ""
}

// ListInteractive shows an interactive picker for any table.
// This is the main entry point for commands wanting interactive list mode.
func ListInteractive(ctx context.Context, app *appctx.App, fetcher *ListFetcher, pageSize int) (*PickerItem, error) {
	queryableFetcher := fetcher.Build(app)

	// Simple title case: capitalize first letter
	tableName := fetcher.Table
	if len(tableName) > 0 {
		tableName = strings.ToUpper(tableName[:1]) + tableName[1:]
	}

	selected, err := PickWithQueryablePagination("Select an item", queryableFetcher,
		WithPickerTitle(tableName+" (type to search, scroll to load more)"),
		WithMaxVisible(20),
		WithPageSize(pageSize),
	)
	if err != nil {
		return nil, fmt.Errorf("picker error: %w", err)
	}

	return selected, nil
}
