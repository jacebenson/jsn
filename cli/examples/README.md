# Examples Directory

This directory contains example scripts demonstrating common JSN CLI workflows.

## Scripts

### incident-management.sh
Common incident management workflows:
- List open critical incidents
- Get incident details
- Create new incidents
- Update incident state
- Resolve incidents

```bash
./incident-management.sh
```

### change-management.sh
Change request management:
- List pending changes
- Create standard changes
- Get change details
- Update change states

```bash
./change-management.sh
```

### development-tasks.sh
Development and code management:
- List script includes
- Get script code
- List business rules
- Manage update sets
- Query system logs

```bash
./development-tasks.sh
```

### data-export.sh
Data export examples:
- Export to CSV
- Export to JSON
- Generate summary reports
- User-specific exports

```bash
./data-export.sh
```

### cicd-integration.sh
CI/CD pipeline integration:
- Create deployment changes
- Update change states
- Handle failures
- Automated closeout

```bash
export SERVICENOW_INSTANCE_URL="https://your-instance.service-now.com"
export SERVICENOW_OAUTH_TOKEN="your-token"
./cicd-integration.sh
```

## Prerequisites

All scripts require:
- JSN CLI installed and configured
- `jq` installed for JSON processing
- Authentication configured (run `jsn setup` first)

## Customization

Edit the scripts to customize:
- Instance URLs
- Query filters
- Column selections
- Output formats

## Making Scripts Executable

```bash
chmod +x *.sh
```
