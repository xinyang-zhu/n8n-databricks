# n8n-databricks

An internal fork of [n8n](https://github.com/n8n-io/n8n) with Databricks authentication integration.

## Purpose

This repository is a **community-driven development fork** of n8n for **internal business use only**. It is:

- **NOT** affiliated with, endorsed by, or sponsored by Databricks, Inc.
- **NOT** a product, distribution, or alternative to n8n
- **NOT** intended for public consumption or third-party hosting
- **NOT** using any n8n Enterprise (`.ee.`) features

"Databricks" is a trademark of Databricks, Inc. This project merely integrates with Databricks services.

This fork exists as a public GitHub repository only because GitHub requires forks of public repositories to be public. This is a standard development workflow, not a redistribution.

## Modifications

### Databricks Token Authentication

- Users authenticate using Databricks personal access tokens
- Automatic user provisioning on first login
- `DATABRICKS_HOST` environment variable integration (protocol prefix auto-stripped)
- Login page displays the configured Databricks host

### Files Modified

- `packages/@n8n/api-types/src/frontend-settings.ts` - Added `databricksHost` to frontend settings
- `packages/cli/src/controllers/auth.controller.ts` - Databricks token login endpoint
- `packages/cli/src/auth/auth.service.ts` - Databricks token authentication middleware

## License Compliance

### Sustainable Use License

This fork complies with the [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md):

| Requirement | Status |
|-------------|--------|
| Internal business use only | Yes |
| No third-party hosting | Yes |
| No removal of license/attribution | Yes |
| No use of Enterprise (.ee.) features | Yes |

### What This License Allows

- Using, copying, and modifying the software for **internal business purposes**
- Self-hosting for internal company use
- Adding custom integrations and authentication

### What This License Prohibits

- Offering n8n to third parties on a hosted or embedded basis
- Removing or obscuring licensing, copyright, or other notices
- Using Enterprise License features without a license

### Enterprise Features (.ee.)

This fork does **NOT** use any `.ee.` files. Enterprise features include but are not limited to:
- SAML/LDAP authentication
- Source control (Git-based workflows)
- External secrets management
- Workflow/credential sharing between users
- Advanced RBAC and permissions
- Audit logging
- Variables

These features require an [Enterprise License](https://github.com/n8n-io/n8n/blob/master/LICENSE_EE.md) from n8n GmbH.

## Environment Variables

### Authentication Methods

```bash
# Databricks Configuration
DATABRICKS_HOST=your-workspace.cloud.databricks.com  # http(s):// prefix optional, will be stripped

# Enable/disable Databricks federated login (via reverse proxy with x-forwarded-access-token)
N8N_AUTH_DATABRICKS_FEDERATED_ENABLED=true  # default: false

# Enable/disable Databricks token login (user provides their PAT)
N8N_AUTH_DATABRICKS_TOKEN_ENABLED=true  # default: false

# Enable/disable email/password login
N8N_AUTH_EMAIL_ENABLED=true  # default: true

# Enable/disable user sign-up (first user becomes owner, subsequent users need invite)
N8N_AUTH_SIGNUP_ENABLED=true  # default: true
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

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build > build.log 2>&1

# Run development server
pnpm dev

# Access at http://localhost:5678
```

## Deployment

For production deployment on Databricks Apps:

```bash
# Build production package
node scripts/build-n8n.mjs

# The compiled/ directory contains the production build
# Run: pnpm install && pnpm start
```

## Upstream

This fork tracks [n8n-io/n8n](https://github.com/n8n-io/n8n). To sync with upstream:

```bash
git fetch upstream
git merge upstream/master
```

## Disclaimer

This is a community-driven project and is **not affiliated with Databricks, Inc.** or n8n GmbH. Use at your own risk.

For official resources:
- **n8n**: https://n8n.io | https://docs.n8n.io | license@n8n.io
- **Databricks**: https://databricks.com


## Run locally

## Deploy

./build-deploy.sh