# jsn CLI Improvements for ServiceNow Catalog Management

## Context
Used jsn CLI to create a ServiceNow catalog form for "Nothing Phones" order tracking.
The underlying API is flexible but low-level. These notes document friction points encountered.

## Status: IMPLEMENTED ✓

The following commands have been added to address these pain points:

### New Commands

**`jsn catalog-item`** (aliases: `cat-item`, `ci`)
- `jsn catalog-item list` - List catalog items with filters
- `jsn catalog-item show <sys_id>` - Show catalog item details
- `jsn catalog-item variables <sys_id>` - List variables on a catalog item

**`jsn variable`** (alias: `var`)
- `jsn variable show <name_or_sys_id>` - Show variable details
- `jsn variable choices <name_or_sys_id>` - List choices for dropdown variable
- `jsn variable add-choice <var> <value> [text]` - Add choice to dropdown
- `jsn variable remove-choice <var> <value>` - Remove choice from dropdown

**`jsn variable-types`** (aliases: `var-types`, `vartypes`)
- Lists all catalog variable types with IDs and descriptions
- Shows which types support question_choice entries

---

## Original Pain Points (Reference)

### 1. Higher-level catalog-item commands
Creating a catalog item with variables requires multiple API calls:
- sc_cat_item
- item_option_new (for each variable)
- sc_cat_item_option (linking variables to item)
- question_choice (for dropdown options)

**Status:** Partially addressed. Listing and viewing implemented. Batch create TBD.

### 2. Human-readable variable types
`type=5` is opaque. Need to know the magic numbers.

**Status:** ✓ DONE - `jsn variable-types` shows all types with human-readable names.

### 3. Variable-specific choice management
Confusing distinction between:
- `question_choice` - variable choices (what we needed)
- `sys_choice` / `jsn choices` - field-level choices

**Status:** ✓ DONE - `jsn variable choices`, `add-choice`, `remove-choice` work with `question_choice` table.

### 4. Validation and warnings
No feedback when:
- Creating a variable without linking it to a catalog item
- Creating choices that reference non-existent variables
- Type is set to dropdown but no choices exist

**Status:** Not yet implemented. Could add validation in future.

### 5. Batch operations
Creating multiple related records requires sequential calls.

**Status:** Not yet implemented. Low priority - can use shell loops for now.

### 6. Catalog item variable listing
Need to query across multiple tables to see what variables exist on an item.

**Status:** ✓ DONE - `jsn catalog-item variables <sys_id>` queries `sc_item_option_mtom` and `item_option_new`.

### 7. Type reference documentation
No built-in help for variable types.

**Status:** ✓ DONE - `jsn variable-types` provides quick reference.

## Summary
The jsn CLI now has a thin abstraction layer for catalog item management:
- ✓ Clear distinction between `choices` (sys_choice) and `variable choices` (question_choice)
- ✓ Human-readable variable types
- ✓ Multi-table relationship management (item → options → definitions)
