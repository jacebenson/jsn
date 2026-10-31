#!/bin/bash
# examples/cicd-integration.sh
# Example: CI/CD integration patterns

set -e

# Configuration
INSTANCE="${SERVICENOW_INSTANCE_URL}"
TOKEN="${SERVICENOW_OAUTH_TOKEN}"

if [ -z "$INSTANCE" ] || [ -z "$TOKEN" ]; then
    echo "Error: SERVICENOW_INSTANCE_URL and SERVICENOW_OAUTH_TOKEN must be set"
    exit 1
fi

echo "=== CI/CD Integration Examples ==="
echo "Instance: $INSTANCE"
echo ""

# 1. Create deployment change request
echo "1. Creating deployment change request..."
CHANGE=$(jsn changes create \
  --description "Production deployment v${VERSION:-1.0.0}" \
  --risk "medium" \
  --json)

CHANGE_NUMBER=$(echo "$CHANGE" | jq -r '.number')
CHANGE_SYS_ID=$(echo "$CHANGE" | jq -r '.sys_id')

echo "Created change: $CHANGE_NUMBER"
echo ""

# 2. Update change with implementation plan
echo "2. Adding implementation plan..."
jsn changes update "$CHANGE_NUMBER" --data '{
  "implementation_plan": "Automated deployment via CI/CD pipeline",
  "backout_plan": "Rollback to previous version",
  "test_plan": "Automated tests passed"
}'
echo ""

# 3. Move to implementation state
echo "3. Moving to implementation state..."
jsn changes update "$CHANGE_NUMBER" --data '{"state": "2"}'
echo ""

# 4. Simulate deployment work
echo "4. Running deployment..."
sleep 2
echo "Deployment complete"
echo ""

# 5. Create deployment incident (if needed)
if [ "${DEPLOYMENT_FAILED:-false}" = "true" ]; then
    echo "5. Creating incident for deployment failure..."
    INCIDENT=$(jsn incidents create \
        --description "Deployment failed for v${VERSION:-1.0.0}" \
        --priority 1 \
        --json)
    echo "Created incident: $(echo "$INCIDENT" | jq -r '.number')"
    
    # Rollback
    echo "Rolling back..."
    jsn changes update "$CHANGE_NUMBER" --data '{"state": "8"}'
    exit 1
else
    echo "5. Deployment successful"
fi
echo ""

# 6. Close change as successful
echo "6. Closing change request..."
jsn changes update "$CHANGE_NUMBER" --data '{
  "state": "3",
  "close_code": "Successful",
  "close_notes": "Deployment completed successfully via CI/CD"
}'
echo ""

echo "=== Done ==="
echo "Change $CHANGE_NUMBER completed successfully"
