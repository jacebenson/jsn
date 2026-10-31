#!/bin/bash
# examples/data-export.sh
# Example: Exporting ServiceNow data

set -e

echo "=== Data Export Examples ==="
echo ""

# 1. Export incidents to CSV
echo "1. Exporting incidents to CSV..."
jsn incidents list \
  --query "opened_at>javascript:gs.daysAgo(30)" \
  --columns "number,short_description,priority,state,opened_by,opened_at" \
  --limit 100 \
  --json | \
  jq -r '.[] | [.number, .short_description, .priority, .state, .opened_by, .opened_at] | @csv' > incidents.csv

echo "Exported to incidents.csv"
echo ""

# 2. Export users to JSON
echo "2. Exporting users to JSON..."
jsn users list --query "active=true" --limit 500 --json > users.json
echo "Exported to users.json"
echo ""

# 3. Export specific table data
echo "3. Exporting change requests to CSV..."
jsn changes list \
  --query "sys_created_on>javascript:gs.daysAgo(90)" \
  --columns "number,short_description,risk,state,sys_created_on" \
  --limit 200 \
  --json | \
  jq -r '.[] | [.number, .short_description, .risk, .state, .sys_created_on] | @csv' > changes.csv

echo "Exported to changes.csv"
echo ""

# 4. Generate summary report
echo "4. Incident Summary Report:"
jsn incidents list \
  --query "opened_at>javascript:gs.daysAgo(7)" \
  --json | \
  jq '
    group_by(.priority) |
    map({
      priority: .[0].priority,
      count: length
    }) |
    sort_by(.priority)
  '
echo ""

# 5. Export for specific user
echo "5. Incidents assigned to specific user:"
ASSIGNED_TO="admin"
jsn incidents list \
  --query "assigned_to.user_name=$ASSIGNED_TO^active=true" \
  --json | \
  jq -r '.[] | "\(.number): \(.short_description)"'
echo ""

echo "=== Done ==="
echo ""
echo "Exported files:"
ls -la *.csv *.json 2>/dev/null || echo "No files exported"
