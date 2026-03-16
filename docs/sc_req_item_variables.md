# ServiceNow Request Item Variables

## Understanding the Data Model

When you see a request item (sc_req_item) in ServiceNow, the variables are NOT stored directly on the record. They're stored in related tables:

### Where Variables Are Stored

1. **sc_item_option** - Stores single-row variable answers
   - `item_option_new` - reference to the question (variable definition)
   - `value` - the answer value
   - `request_item` - reference to the RITM

2. **sc_multi_row_question_answer** - Stores multi-row variable set (MRVS) answers
   - `parent_id` - reference to the RITM (sys_id of sc_req_item)
   - `row_index` - identifies which row in the MRVS
   - `item_option_new` - reference to the question
   - `value` - the answer value

### How to Query Variables

#### Single-Row Variables

Query sc_item_option directly:
```bash
jsn records query sc_item_option "request_item=<sys_id>" --fields item_option_new,value
```

#### Multi-Row Variable Sets (MRVS)

Query sc_multi_row_question_answer by parent_id (the RITM sys_id):
```bash
# Get all MRVS answers for a RITM
jsn records query sc_multi_row_question_answer "parent_id=<ritm_sys_id>" --fields row_index,item_option_new,value

# Format as table (requires jq)
jsn records query sc_multi_row_question_answer "parent_id=<ritm_sys_id>" --fields row_index,item_option_new,value | jq '
  .data |
  group_by(.row_index) |
  .[] |
  {
    row: .[0].row_index,
    fields: map({(.item_option_new.display_value): .value}) | add
  }
'
```

**Example Output:**
```
| Row | Title                | First Name | Nickname |
|-----|----------------------|------------|----------|
| 1   |                      | jj         | john     |
| 2   | Administrator        | Jace       | jace     |
| 3   | Manager Person       | tim        | prof     |
```

## Simplified View with --fields

The `--fields` flag has been added to `jsn records show` to help you see what matters:

```bash
# Instead of seeing all 50+ fields:
jsn records show sc_req_item <sys_id>

# See only what you care about:
jsn records show sc_req_item <sys_id> --fields number,state,stage,approval,cat_item,requested_for,quantity,price

# View as JSON for scripting:
jsn records show sc_req_item <sys_id> --fields number,state,short_description --json | jq '.data'
```

## Common Request Item Fields

| Field | Description |
|-------|-------------|
| number | RITM number (e.g., RITM0000001) |
| state | Current state (Open, Work in Progress, Closed) |
| stage | Request stage (requested, approval, fulfillment, etc.) |
| approval | Approval status (Requested, Approved, Rejected) |
| cat_item | Catalog item requested |
| requested_for | User the item is for |
| request | Parent REQ number |
| quantity | Quantity requested |
| price | Price per unit |
| short_description | Short description |
| description | Full description |
| active | Whether the RITM is active |
| opened_at | When it was opened |
| closed_at | When it was closed |
| assigned_to | Who it's assigned to |
| assignment_group | Assignment group |
| configuration_item | CI being requested |

## Pro Tips

1. **Use --json with jq for filtering:**
   ```bash
   jsn records show sc_req_item <sys_id> --json | jq '.data | {number, state, cat_item}'
   ```

2. **Find single-row variables for a specific RITM:**
   ```bash
   jsn records query sc_item_option "request_item=<sys_id>" --json | jq '.data[] | {question: .item_option_new.display_value, answer: .value}'
   ```

3. **View MRVS data in table format:**
   ```bash
   RITM="<sys_id>"
   jsn records query sc_multi_row_question_answer "parent_id=$RITM" --fields row_index,item_option_new,value | jq -r '
     .data |
     group_by(.row_index) |
     .[] |
     "Row: \(.[0].row_index)",
     (.[] | "  \(.item_option_new.display_value): \(.value)"),
     ""
   '
   ```

4. **View in ServiceNow UI:**
   All commands provide a link breadcrumb at the end. Just click it!
