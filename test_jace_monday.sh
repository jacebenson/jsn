#!/bin/bash
# Test script for "Jace Monday Check" flow
# This follows the Flow Variables First pattern

set -e  # Exit on error

echo "=== Jace Monday Check Flow Test ==="
echo ""

FLOW_NAME="Jace Monday Check $(date +%s)"  # Unique name with timestamp
echo "Creating flow: $FLOW_NAME"

# Step 1: Create the flow
echo ""
echo "Step 1: Creating flow..."
./bin/jsn flows create --name "$FLOW_NAME" --type flow --no-updateset-warning

# Step 2: Add trigger for incident creation with "jace" in short description
echo ""
echo "Step 2: Adding trigger (incident created with 'jace' in description)..."
./bin/jsn flows triggers add "$FLOW_NAME" \
  --type created \
  --table incident \
  --condition "short_descriptionLIKEjace" \
  --no-updateset-warning

# Step 3: Create flow variable FIRST
echo ""
echo "Step 3: Creating flow variable 'day_of_week'..."
./bin/jsn flows variables add "$FLOW_NAME" \
  --name day_of_week \
  --type integer \
  --label "Day of Week (0=Sun, 1=Mon, ...)" \
  --no-updateset-warning

# Step 4: Add Set Flow Variables action to calculate day
echo ""
echo "Step 4: Adding Set Flow Variables action..."
./bin/jsn flows actions add "$FLOW_NAME" \
  --type set_variable \
  --input "variable=day_of_week" \
  --input "script=new Date().getDay()" \
  --no-updateset-warning

# Step 5: Add If condition to check if Monday (day 1)
echo ""
echo "Step 5: Adding If condition for Monday check..."
./bin/jsn flows actions add "$FLOW_NAME" \
  --type if \
  --input "condition={{flow_variable.day_of_week}}=1" \
  --input "label=Is Monday" \
  --no-updateset-warning

# Step 6: Add Update Record action
echo ""
echo "Step 6: Adding Update Record action..."
./bin/jsn flows actions add "$FLOW_NAME" \
  --type update_record \
  --table incident \
  --input "record={{trigger.current}}" \
  --input "fields=work_notes=Do you have a case of the Mondays?" \
  --no-updateset-warning

# Step 7: SAVE THE FLOW - This is critical!
echo ""
echo "Step 7: Saving flow to regenerate version payload..."
./bin/jsn flows save "$FLOW_NAME" --no-updateset-warning

# Step 8: List actions to verify
echo ""
echo "Step 8: Listing actions to verify..."
./bin/jsn flows actions list "$FLOW_NAME" --no-updateset-warning

echo ""
echo "=== Flow created successfully! ==="
echo ""
echo "Flow name: $FLOW_NAME"
echo ""
echo "IMPORTANT: Changes are now visible in Flow Designer!"
echo "Open the flow in ServiceNow to verify."
