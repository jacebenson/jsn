// Package tui provides terminal UI formatting utilities.
package tui

import (
	"fmt"
	"strings"
)

// SectionHeader creates a section header with box drawing characters.
func SectionHeader(title string) string {
	return fmt.Sprintf("─ %s ─", title)
}

// FieldLine creates a formatted field line.
func FieldLine(name string, value string, indent int) string {
	prefix := strings.Repeat("  ", indent)
	if value == "" {
		value = "(empty)"
	}
	return fmt.Sprintf("%s%s: %s", prefix, name, value)
}

// FormatAttachment formats an attachment for display.
// Returns the formatted string and any error.
func FormatAttachment(fileName, createdBy, createdOn, sysID string) string {
	if createdBy != "" && createdOn != "" {
		return fmt.Sprintf("  %s (by %s on %s)", fileName, createdBy, createdOn)
	}
	return fmt.Sprintf("  %s", fileName)
}

// FormatLink creates a ServiceNow URL.
func FormatLink(instanceURL, table, sysID string) string {
	if instanceURL == "" || table == "" || sysID == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s.do?sys_id=%s", instanceURL, table, sysID)
}

// FormatAttachmentLink creates a link to an attachment.
func FormatAttachmentLink(instanceURL, sysID string) string {
	if instanceURL == "" || sysID == "" {
		return ""
	}
	return fmt.Sprintf("%s/sys_attachment.do?sys_id=%s", instanceURL, sysID)
}

// RecordField represents a field in a formatted record.
type RecordField struct {
	Name  string
	Value string
	Label string // Optional: override the displayed name
}

// RecordSection represents a section of fields.
type RecordSection struct {
	Title  string
	Fields []RecordField
}

// FormatRecordSections formats record data into sections.
func FormatRecordSections(title string, sections []RecordSection) string {
	var b strings.Builder

	// Title
	if title != "" {
		b.WriteString(fmt.Sprintf("\n%s\n\n", title))
	}

	// Sections
	for _, section := range sections {
		if len(section.Fields) == 0 {
			continue
		}

		// Check if any field has a value
		hasValues := false
		for _, f := range section.Fields {
			if f.Value != "" {
				hasValues = true
				break
			}
		}
		if !hasValues {
			continue
		}

		b.WriteString(SectionHeader(section.Title))
		b.WriteString("\n")

		for _, field := range section.Fields {
			if field.Value == "" {
				continue
			}

			label := field.Label
			if label == "" {
				label = field.Name
			}

			// Handle multi-line values
			if strings.Contains(field.Value, "\n") {
				b.WriteString(fmt.Sprintf("  %s:\n", label))
				for _, line := range strings.Split(field.Value, "\n") {
					if line != "" {
						b.WriteString(fmt.Sprintf("    %s\n", line))
					}
				}
			} else {
				b.WriteString(fmt.Sprintf("  %s: %s\n", label, field.Value))
			}
		}
		b.WriteString("\n")
	}

	return b.String()
}

// FilterNonEmpty returns only fields with non-empty values.
func FilterNonEmpty(fields []RecordField) []RecordField {
	var result []RecordField
	for _, f := range fields {
		if f.Value != "" {
			result = append(result, f)
		}
	}
	return result
}
