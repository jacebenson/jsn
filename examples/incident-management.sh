#!/bin/bash
# examples/incident-management.sh
# Example: Common incident management workflows

set -e

# Configuration
INSTANCE="${SERVICENOW_INSTANCE_URL:-https://your-instance.service-now.com}"

echo "=== Incident Management Examples ==="
echo "Instance: $INSTANCE"
echo ""

# 1. List all open critical incidents
echo "1. Open Critical Incidents:"
jsn incidents list --query "priority=1^active=true^state!=6" --limit 5
echo ""

# 2. Get incident details
echo "2. Incident Details:"
jsn incidents INC0010001 --json | jq '.{
  number,
  short_description,
  priority,
  state,
  assigned_to
}'
echo ""

# 3. Create a new incident
echo "3. Creating new incident..."
NEW_INCIDENT=$(jsn incidents create \
  --description "Server CPU utilization high" \
  --priority 2 \
  --json)

echo "Created: $(echo "$NEW_INCIDENT" | jq -r '.number')"
echo ""

# 4. Update incident state
echo "4. Updating incident state..."
jsn incidents update INC0010001 --data '{
  "state": "2",
  "work_notes": "Investigating the issue"
}'
echo ""

# 5. Resolve an incident
echo "5. Resolving incident..."
jsn incidents update INC0010001 --data '{
  "state": "6",
  "close_code": "Resolved",
  "close_notes": "Issue resolved after server restart"
}'
echo ""

echo "=== Done ==="
