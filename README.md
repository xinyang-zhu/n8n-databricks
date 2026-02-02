# n8n-databricks

An internal fork of [n8n](https://github.com/n8n-io/n8n) with Databricks authentication integration.

## Disclaimer

This repository is a **community-driven development fork** of n8n for **internal business use only**. It is:

- **NOT** affiliated with, endorsed by, or sponsored by Databricks, Inc. or n8n GmbH
- **NOT** a product, distribution, or alternative to n8n
- **NOT** referring or using any enterprise licensed code (files that contain `.ee.` in their filename or `.ee` in their dirname)

The license for this fork is **NOT modified**. By using this fork, you must follow the same [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md) as the original n8n project.

This fork is provided **as-is** and will only support a limited number of n8n versions. It may not be kept up-to-date with the latest upstream releases.

For official resources:
- **n8n**: https://n8n.io | https://docs.n8n.io
- **Databricks**: https://databricks.com

"Databricks" is a trademark of Databricks, Inc. This project merely integrates with Databricks services.

## Features

### Databricks Authentication

- **Federated Login**: Automatic authentication via reverse proxy with `x-forwarded-access-token` header (for Databricks Apps deployment)
- **Token Login**: Users can authenticate using their Databricks Personal Access Token (PAT)
- **Auto-provisioning**: Users are automatically created on first login

### Databricks RBAC (Role-Based Access Control)

- Grant permissions to Databricks users, groups, and service principals
- Control access to workflows, credentials, and data tables
- Works independently from n8n's native permissions (OR logic - access granted if either system allows)

## Environment Variables

### Databricks Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABRICKS_HOST` | _(required)_ | Databricks workspace host (e.g., `your-workspace.cloud.databricks.com`). Protocol prefix is auto-stripped. |
| `DATABRICKS_CLIENT_ID` | _(optional)_ | Service principal client ID for SCIM API calls. Required for listing users/groups/service-principals in the permissions modal. |
| `DATABRICKS_CLIENT_SECRET` | _(optional)_ | Service principal client secret for SCIM API calls. |
| `N8N_DATABRICKS_RBAC_ENABLED` | `true` | Enable Databricks-based permissions for workflows, credentials, and data tables. Works independently from n8n's native permissions (OR logic). |

> **Note:** If `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` are not set, the permissions modal will still work but won't be able to list available principals from Databricks.

### Authentication Methods

| Variable | Default | Description |
|----------|---------|-------------|
| `N8N_AUTH_DATABRICKS_FEDERATED_ENABLED` | `false` | Enable Databricks federated login via reverse proxy with `x-forwarded-access-token` header. Use this when deploying on Databricks Apps. |
| `N8N_AUTH_DATABRICKS_TOKEN_ENABLED` | `false` | Enable Databricks token login where users provide their Personal Access Token (PAT). |
| `N8N_AUTH_EMAIL_ENABLED` | `true` | Enable email/password login. |
| `N8N_AUTH_SIGNUP_ENABLED` | `true` | Enable user sign-up. First user becomes owner, subsequent users need invite. |

### Example Configurations

**Databricks Apps Deployment (Federated Login Only):**
```bash
DATABRICKS_HOST=your-workspace.cloud.databricks.com
N8N_AUTH_DATABRICKS_FEDERATED_ENABLED=true
N8N_AUTH_EMAIL_ENABLED=false
N8N_DATABRICKS_RBAC_ENABLED=true
DATABRICKS_CLIENT_ID=your-service-principal-client-id
DATABRICKS_CLIENT_SECRET=your-service-principal-secret
```

**Local Development (Token + Email Login):**
```bash
DATABRICKS_HOST=your-workspace.cloud.databricks.com
N8N_AUTH_DATABRICKS_TOKEN_ENABLED=true
N8N_AUTH_EMAIL_ENABLED=true
N8N_DATABRICKS_RBAC_ENABLED=true
```

**Standard n8n (No Databricks):**
```bash
N8N_AUTH_EMAIL_ENABLED=true
N8N_DATABRICKS_RBAC_ENABLED=false
```

### Database (PostgreSQL recommended)

```bash
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=localhost
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=n8n
DB_POSTGRESDB_PASSWORD=your-password
```