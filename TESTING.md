# Testing the Jace Monday Check Flow

## Prerequisites

1. Build the CLI:
```bash
go build -o bin/jsn ./cmd/jsn/main.go
```

2. Ensure you're authenticated:
```bash
./bin/jsn auth status
```

## The Test Flow

### ❌ What Doesn't Work (Will Be Blocked)

```bash
# This will FAIL with a helpful error:
./bin/jsn flows actions add "My Flow" --type if \
  --input "condition=dayOfWeek()==1"

# Error: inline logic not allowed: 'dayOfWeek()'
# Flow Designer requires flow variables for logic conditions.
```

### ✅ What Works (Flow Variables First)

```bash
#!/bin/bash
# test_jace_flow.sh

FLOW_NAME="Jace Monday Check Test"

echo "=== Creating Jace Monday Check Flow ==="

# 1. Create flow
./bin/jsn flows create --name "$FLOW_NAME" --type flow --no-updateset-warning

# 2. Add trigger
./bin/jsn flows triggers add "$FLOW_NAME" \
  --type created \
  --table incident \
  --condition "short_descriptionLIKEjace" \
  --no-updateset-warning

# 3. Create flow variable FIRST
./bin/jsn flows variables add "$FLOW_NAME" \
  --name day_of_week \
  --type integer \
  --label "Day of Week (0=Sun, 1=Mon, ...)" \
  --no-updateset-warning

# 4. Set the variable value
./bin/jsn flows actions add "$FLOW_NAME" \
  --type set_variable \
  --variable day_of_week \
  --script "new Date().getDay()" \
  --no-updateset-warning

# 5. Use variable in If condition (THIS WORKS!)
./bin/jsn flows actions add "$FLOW_NAME" \
  --type if \
  --input "condition={{flow_variable.day_of_week}}=1" \
  --input "label=Is Monday" \
  --no-updateset-warning

# 6. Add Update action
./bin/jsn flows actions add "$FLOW_NAME" \
  --type update_record \
  --table incident \
  --input "record={{trigger.current}}" \
  --input "fields=work_notes=Do you have a case of the Mondays?" \
  --no-updateset-warning

echo ""
echo "=== Flow created! ==="
echo "Now list actions to get the If block ID and move the Update action inside it:"
echo "  ./bin/jsn flows actions list \"$FLOW_NAME\""
echo "  ./bin/jsn flows actions move \"$FLOW_NAME\" <action_id> --parent <if_id>"
```

## Expected Behavior

### Step 1-4: Should Succeed
- Flow created ✓
- Trigger added ✓  
- Variable created ✓
- Set variable action added ✓

### Step 5: Should Succeed (Uses Flow Variable)
```bash
./bin/jsn flows actions add "$FLOW_NAME" \
  --type if \
  --input "condition={{flow_variable.day_of_week}}=1"
```

**Result**: ✅ Action added successfully

### Alternative: Using Boolean Variable (Cleaner)

```bash
# Create boolean variable
./bin/jsn flows variables add "$FLOW_NAME" \
  --name is_monday \
  --type boolean \
  --label "Is Today Monday?"

# Set with script
./bin/jsn flows actions add "$FLOW_NAME" \
  --type set_variable \
  --variable is_monday \
  --script "new Date().getDay() === 1"

# Use in condition (cleaner!)
./bin/jsn flows actions add "$FLOW_NAME" \
  --type if \
  --input "condition={{flow_variable.is_monday}}=true"
```

## Validation Testing

### Test 1: Inline Logic Should Fail
```bash
./bin/jsn flows actions add "test" --type if \
  --input "condition=dayOfWeek()==1" \
  --no-updateset-warning

# Expected: Error with helpful message
```

### Test 2: Variable Reference Should Succeed
```bash
./bin/jsn flows actions add "test" --type if \
  --input "condition={{flow_variable.day_of_week}}=1" \
  --no-updateset-warning

# Expected: Success (if variable exists)
```

### Test 3: Other Inline Patterns Blocked
```bash
# These should all fail:
./bin/jsn flows actions add "test" --type if --input "condition=new Date().getDay()"
./bin/jsn flows actions add "test" --type if --input "condition=now()"
./bin/jsn flows actions add "test" --type if --input "condition=today()"
```

## Troubleshooting

### "Variable not found" Error
If you get this when referencing `{{flow_variable.day_of_week}}`, the variable wasn't created. Run:
```bash
./bin/jsn flows variables list "Your Flow Name"
```

### "Flow not found" Error
Use the exact flow name or sys_id:
```bash
./bin/jsn flows  # List all flows to find the name
```

### Phantom Actions
If you see unexpected Log actions:
```bash
# List and remove them
./bin/jsn flows actions list "Your Flow"
./bin/jsn flows actions remove "Your Flow" <phantom_action_id>
```

## Success Criteria

✅ Flow created without errors
✅ Trigger shows in Flow Designer
✅ Variable created and visible
✅ Set Variable action executes script
✅ If condition references variable correctly
✅ No "inline logic not allowed" errors (because we're using variables!)

## Notes

- The CLI validates conditions BEFORE sending to ServiceNow
- The error message tells you exactly how to fix it
- Flow variables must be created BEFORE referencing in conditions
- Use `set_variable` action to calculate dynamic values
- The pattern is: **Variable → Set Value → Use in Logic**
