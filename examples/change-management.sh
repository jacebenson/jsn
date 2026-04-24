#!/bin/bash
# examples/change-management.sh
# Example: Change request workflows

set -e

echo "=== Change Management Examples ==="
echo ""

# 1. List pending changes
echo "1. Pending Changes:"
jsn changes list --query "state=-5" --limit 10
echo ""

# 2. Create a standard change
echo "2. Creating standard change..."
NEW_CHANGE=$(jsn changes create \
  --description "Monthly security patch deployment" \
  --risk "low" \
  --json)

echo "Created: $(echo "$NEW_CHANGE" | jq -r '.number')"
echo ""

# 3. Get change details
echo "3. Change Details:"
jsn changes CHG0010001 --json | jq '{
  number,
  short_description,
  risk,
  state,
  approval
}'
echo ""

# 4. List high-risk changes
echo "4. High Risk Changes:"
jsn changes list --query "risk=high^state!=3" --limit 5
echo ""

# 5. Update change state (implement)
echo "5. Moving change to implementation..."
jsn changes update CHG0010001 --data '{
  "state": "2",
  "implementation_plan": "1. Backup database\n2. Deploy patch\n3. Verify"
}'
echo ""

echo "=== Done ==="
