#!/bin/bash
# examples/development-tasks.sh
# Example: Development and code management workflows

set -e

echo "=== Development Tasks Examples ==="
echo ""

# 1. List script includes in a scope
echo "1. Script Includes in Global Scope:"
jsn dev includes list --query "sys_scope.scope=global^active=true" --limit 10
echo ""

# 2. Get script include code
echo "2. Script Include Code:"
jsn dev includes "MyScriptInclude" --json | jq -r '.script'
echo ""

# 3. List active business rules on incident table
echo "3. Active Business Rules on Incident:"
jsn dev rules list --query "collection=incident^active=true" --limit 10
echo ""

# 3b. List client scripts on incident table
echo "3b. Client Scripts on Incident:"
jsn dev clientscripts list --query "table_name=incident^active=true" --limit 10
echo ""

# 3c. List UI actions on incident table
echo "3c. UI Actions on Incident:"
jsn dev uiactions list --query "table=incident^active=true" --limit 10
echo ""

# 4. List in-progress update sets
echo "4. In-Progress Update Sets:"
jsn dev updatesets list --query "state=in progress" --limit 10
echo ""

# 5. Set current update set
echo "5. Setting current update set..."
jsn dev updatesets set "My Development Update Set"
echo ""

# 6. List application scopes
echo "6. Application Scopes:"
jsn dev scopes list --limit 10
echo ""

# 7. Get table definition
echo "7. Incident Table Definition:"
jsn dev tables incident --json | jq '{
  name,
  label,
  sys_class_name,
  create_access_controls
}'
echo ""

# 8. List table columns (using dev columns command)
echo "8. Incident Table Columns:"
jsn dev columns --table incident --limit 20
echo ""

# 9. Query system logs
echo "9. Recent Errors:"
jsn dev logs list --level error --limit 10
echo ""

# 10. List ACLs for incident table
echo "10. ACLs for Incident Table:"
jsn dev acls list --query "name=incident" --limit 10
echo ""

# 11. List system properties
echo "11. System Properties:"
jsn dev properties list --query "nameLIKEglide" --limit 10
echo ""

echo "=== Done ==="
