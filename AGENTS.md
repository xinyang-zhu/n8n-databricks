# AGENTS.md

This file provides guidance on how to work with the n8n repository.

## Project Overview

n8n is a workflow automation platform written in TypeScript, using a monorepo
structure managed by pnpm workspaces. It consists of a Node.js backend, Vue.js
frontend, and extensible node-based workflow engine.

## General Guidelines

- Always use pnpm
- We use Linear as a ticket tracking system
- We use Posthog for feature flags
- When starting to work on a new ticket – create a new branch from fresh
  master with the name specified in Linear ticket
- When creating a new branch for a ticket in Linear - use the branch name
  suggested by linear
- Use mermaid diagrams in MD files when you need to visualise something

## CRITICAL: Avoiding Stale State

**NEVER debug in circles. Check for stale state FIRST.**

### Stale Builds

When code looks correct but doesn't work (imports undefined, console.logs don't
appear, changes not reflected):

1. **Check build warnings** - `IMPORT_IS_UNDEFINED` means the dependency package
   needs rebuilding
2. **Rebuild dependent packages in order:**
   ```bash
   # If you modified @n8n/rest-api-client, @n8n/api-types, n8n-workflow, etc.
   pnpm --filter=@n8n/rest-api-client build  # Build the dependency FIRST
   pnpm --filter=n8n-editor-ui build          # Then build the consumer
   ```
3. **Package dependency order:**
   - `n8n-workflow` → `@n8n/api-types` → `@n8n/rest-api-client` → `n8n-editor-ui`
   - Always rebuild downstream packages after modifying upstream ones

### Stale Environment Variables

When services fail with "not enabled" or config-related errors:

1. **Always source shell config before starting services:**
   ```bash
   source ~/.zshrc && ./dev.sh restart
   ```
2. **Verify env vars are actually loaded:**
   ```bash
   env | grep -E "N8N_|DATABRICKS_"
   ```
3. **Don't assume** - variables in `.zshrc` are NOT automatically in Claude's
   shell session

### Stale Frontend Cache

The server caches frontend in `~/.cache/n8n/public/`. Always use `./dev.sh restart`
which clears this cache automatically.

## Essential Commands

### Building
Use `pnpm build` to build all packages. ALWAYS redirect the output of the
build command to a file:

```bash
pnpm build > build.log 2>&1
```

You can inspect the last few lines of the build log file to check for errors:
```bash
tail -n 20 build.log
```

### Development Server
Use the `dev.sh` script for fast development:

```bash
./dev.sh restart   # Stop, build CLI, start (default)
./dev.sh build     # Build CLI package only
./dev.sh start     # Start without building
./dev.sh stop      # Stop n8n
```

Or run the n8n binary directly (skips rebuild):
```bash
./packages/cli/bin/n8n
```

The backend serves both the API and the editor UI on a single port:
- **Editor UI + API**: http://localhost:5678

**Note:** Avoid using `pnpm dev` as it tries to start 40+ packages in parallel
with turbo, which is slow and often times out.

### Build Workflow for Different Change Types

**CRITICAL: Understand what needs rebuilding based on what you changed.**

#### Backend Changes (packages/cli, packages/@n8n/db, packages/@n8n/config, etc.)
```bash
./dev.sh restart   # Rebuilds CLI and restarts server
```

#### Frontend Changes (packages/frontend/editor-ui)

**CRITICAL: Understand the frontend serving pipeline:**
```
Source (.vue files)
    ↓ pnpm build
packages/frontend/editor-ui/dist/
    ↓ Server copies on START
~/.cache/n8n/public/           ← Server serves from HERE (NEVER auto-cleared!)
    ↓
Browser
```

**The server caches frontend assets in `~/.cache/n8n/public/` on startup.**
**dev.sh automatically clears this cache on every start/restart.**

**Standard frontend change workflow:**
```bash
# Step 1: Build frontend
cd packages/frontend/editor-ui && pnpm build

# Step 2: Restart server (clears cache + copies new dist)
./dev.sh restart

# Step 3: Refresh browser (Cmd+Shift+R to bypass browser cache)
```

#### Verifying Your Build Applied
Always verify your changes were actually built AND cached:
```bash
# 1. Check source file modification time
stat -f "%Sm" packages/frontend/editor-ui/src/app/components/YourFile.vue

# 2. Check dist folder exists and is newer than source
stat -f "%Sm" packages/frontend/editor-ui/dist/index.html

# 3. Check cache is newer than dist (populated on server start)
stat -f "%Sm" ~/.cache/n8n/public/index.html

# Timeline should be: Source < Dist < Cache
```

If dist is missing or older than source → run `pnpm build` in editor-ui
If cache is older than dist → restart server with `./dev.sh restart`

#### Debugging Frontend Not Updating
```bash
# Find the CSS file for your component in the cache
grep -l "YourClassName" ~/.cache/n8n/public/assets/*.css

# Check what CSS is actually being served
grep "your-css-property" ~/.cache/n8n/public/assets/YourFile.css
```

#### Full Rebuild (when dependencies change or things are broken)
```bash
pnpm build > build.log 2>&1
tail -n 20 build.log  # Check for errors
```

#### Summary Table
| Changed Files | Command | Server Restart? | Browser Refresh? |
|--------------|---------|-----------------|------------------|
| Backend (CLI, services, controllers) | `./dev.sh restart` | Yes (automatic) | Yes |
| Frontend (Vue components, CSS) | `cd packages/frontend/editor-ui && pnpm build` then `./dev.sh restart` | **YES** (to update cache) | Yes (disable cache) |
| Shared types (@n8n/api-types) | `pnpm build` then `./dev.sh restart` | Yes | Yes |
| Database entities/migrations | `./dev.sh restart` | Yes | Yes |

**WARNING:** Frontend changes require server restart because the server caches
frontend assets in `~/.cache/n8n/public/` on startup.

### Testing
- `pnpm test` - Run all tests
- `pnpm test:affected` - Runs tests based on what has changed since the last
  commit

Running a particular test file requires going to the directory of that test
and running: `pnpm test <test-file>`.

When changing directories, use `pushd` to navigate into the directory and
`popd` to return to the previous directory. When in doubt, use `pwd` to check
your current directory.

### Code Quality
- `pnpm lint` - Lint code
- `pnpm typecheck` - Run type checks

Always run lint and typecheck before committing code to ensure quality.
Execute these commands from within the specific package directory you're
working on (e.g., `cd packages/cli && pnpm lint`). Run the full repository
check only when preparing the final PR. When your changes affect type
definitions, interfaces in `@n8n/api-types`, or cross-package dependencies,
build the system before running lint and typecheck.

## Architecture Overview

**Monorepo Structure:** pnpm workspaces with Turbo build orchestration

### Package Structure

The monorepo is organized into these key packages:

- **`packages/@n8n/api-types`**: Shared TypeScript interfaces between frontend and backend
- **`packages/workflow`**: Core workflow interfaces and types
- **`packages/core`**: Workflow execution engine
- **`packages/cli`**: Express server, REST API, and CLI commands
- **`packages/editor-ui`**: Vue 3 frontend application
- **`packages/@n8n/i18n`**: Internationalization for UI text
- **`packages/nodes-base`**: Built-in nodes for integrations
- **`packages/@n8n/nodes-langchain`**: AI/LangChain nodes
- **`@n8n/design-system`**: Vue component library for UI consistency
- **`@n8n/config`**: Centralized configuration management

## Technology Stack

- **Frontend:** Vue 3 + TypeScript + Vite + Pinia + Storybook UI Library
- **Backend:** Node.js + TypeScript + Express + TypeORM
- **Testing:** Jest (unit) + Playwright (E2E)
- **Database:** TypeORM with SQLite/PostgreSQL/MySQL support
- **Code Quality:** Biome (for formatting) + ESLint + lefthook git hooks

### Key Architectural Patterns

1. **Dependency Injection**: Uses `@n8n/di` for IoC container
2. **Controller-Service-Repository**: Backend follows MVC-like pattern
3. **Event-Driven**: Internal event bus for decoupled communication
4. **Context-Based Execution**: Different contexts for different node types
5. **State Management**: Frontend uses Pinia stores
6. **Design System**: Reusable components and design tokens are centralized in
   `@n8n/design-system`, where all pure Vue components should be placed to
   ensure consistency and reusability

## Key Development Patterns

- Each package has isolated build configuration and can be developed independently
- Hot reload works across the full stack during development
- Node development uses dedicated `node-dev` CLI tool
- Workflow tests are JSON-based for integration testing
- AI features have dedicated development workflow (`pnpm dev:ai`)

### Workflow Traversal Utilities

The `n8n-workflow` package exports graph traversal utilities from
`packages/workflow/src/common/`. Use these instead of custom traversal logic.

**Key concept:** `workflow.connections` is indexed by **source node**.
To find parent nodes, use `mapConnectionsByDestination()` to invert it first.

```typescript
import { getParentNodes, getChildNodes, mapConnectionsByDestination } from 'n8n-workflow';

// Finding parent nodes (predecessors) - requires inverted connections
const connectionsByDestination = mapConnectionsByDestination(workflow.connections);
const parents = getParentNodes(connectionsByDestination, 'NodeName', 'main', 1);

// Finding child nodes (successors) - uses connections directly
const children = getChildNodes(workflow.connections, 'NodeName', 'main', 1);
```

### TypeScript Best Practices
- **NEVER use `any` type** - use proper types or `unknown`
- **Avoid type casting with `as`** - use type guards or type predicates instead
- **Define shared interfaces in `@n8n/api-types`** package for FE/BE communication

### Error Handling
- Don't use `ApplicationError` class in CLI and nodes for throwing errors,
  because it's deprecated. Use `UnexpectedError`, `OperationalError` or
  `UserError` instead.
- Import from appropriate error classes in each package

### Frontend Development
- **All UI text must use i18n** - add translations to `@n8n/i18n` package
- **Use CSS variables directly** - never hardcode spacing as px values
- **data-test-id must be a single value** (no spaces or multiple values)

When implementing CSS, refer to @packages/frontend/CLAUDE.md for guidelines on
CSS variables and styling conventions.

### Testing Guidelines
- **Always work from within the package directory** when running tests
- **Mock all external dependencies** in unit tests
- **Confirm test cases with user** before writing unit tests
- **Typecheck is critical before committing** - always run `pnpm typecheck`
- **When modifying pinia stores**, check for unused computed properties

What we use for testing and writing tests:
- For testing nodes and other backend components, we use Jest for unit tests. Examples can be found in `packages/nodes-base/nodes/**/*test*`.
- We use `nock` for server mocking
- For frontend we use `vitest`
- For E2E tests we use Playwright. Run with `pnpm --filter=n8n-playwright test:local`.
  See `packages/testing/playwright/README.md` for details.

### Common Development Tasks

When implementing features:
1. Define API types in `packages/@n8n/api-types`
2. Implement backend logic in `packages/cli` module, follow
   `@packages/cli/scripts/backend-module/backend-module-guide.md`
3. Add API endpoints via controllers
4. Update frontend in `packages/editor-ui` with i18n support
5. Write tests with proper mocks
6. Run `pnpm typecheck` to verify types

## Databricks RBAC Integration

This fork adds Databricks-based Role-Based Access Control (RBAC) that works
independently of n8n's native permissions.

### Architecture

- **Permission Storage**: `databricks_securable_permission` table stores
  permissions for workflows, credentials, and data tables
- **Identity Resolution**: Uses Databricks SCIM API (`/api/2.0/preview/scim/v2/Me`)
  to get user ID and group memberships from Databricks token
- **Permission Hierarchy**: READ < USE < WRITE < MANAGE (higher includes lower)

### Key Files

- `packages/cli/src/services/databricks-permission.service.ts` - Core permission
  checking and management
- `packages/cli/src/controllers/databricks-permissions.controller.ts` - REST API
  for managing permissions
- `packages/@n8n/db/src/entities/databricks-securable-permission.ts` - Database
  entity
- `packages/frontend/editor-ui/src/app/components/DatabricksPermissionsModal.vue`
  - UI for managing permissions

### Current Status

| Resource    | Individual Access | Listing in Overview | Notes |
|-------------|-------------------|---------------------|-------|
| Workflows   | ✅ Working        | ✅ Working          | Users see workflows they have Databricks access to |
| Credentials | ✅ Working        | ✅ Working          | Users see credentials they have Databricks access to |
| Data Tables | ✅ Working        | ❌ Not implemented  | See limitation below |

### Data Tables Limitation

**Data tables do NOT appear in a global listing** like workflows and credentials.

**Reason**: Data tables are architecturally project-scoped:
- Endpoint: `/rest/projects/:projectId/data-tables` (requires project ID)
- No global `/rest/data-tables` endpoint exists
- Users can only view data tables within projects they have n8n access to

**Current behavior**:
- Databricks RBAC checks work for individual data table operations (read, write,
  delete columns/rows, etc.)
- But users won't see data tables from other projects in the UI unless they have
  n8n project access

**To fix**: Would require either:
1. A new global `/rest/data-tables` endpoint that lists all Databricks-accessible
   data tables across projects
2. Frontend changes to aggregate data tables from multiple projects

### Permission Logic: MERGE(DBX, N8N)

**CRITICAL**: The two permission systems are independent and use OR logic:
- `Permission = MERGE(DBX, N8N)` - user has access if EITHER system grants it
- Never "check one first, fallback to other" - always check BOTH
- If Databricks grants USE and n8n grants nothing → allowed
- If n8n grants workflow:execute and Databricks grants nothing → allowed

**Correct pattern** (without @ProjectScope decorator):
```typescript
@Get('/:workflowId')
async getWorkflow(req: WorkflowRequest.Get) {
    const { workflowId } = req.params;

    // Check BOTH permission systems
    const hasDatabricksAccess = this.globalConfig.databricks.rbacEnabled &&
        (await this.hasDatabricksPermission(req, workflowId, 'READ'));
    const hasN8nAccess = await userHasScopes(req.user, ['workflow:read'], false, { workflowId });

    // Allow if EITHER grants access
    if (!hasDatabricksAccess && !hasN8nAccess) {
        throw new ForbiddenError('...');
    }
    // ... rest of method
}
```

**Incorrect pattern** (DO NOT USE):
```typescript
@ProjectScope('workflow:read')  // ❌ Runs BEFORE method body, blocks Databricks check
async getWorkflow(req: WorkflowRequest.Get) {
    await this.checkDatabricksPermission(req, workflowId, 'READ');  // ❌ Never reached if n8n denies
}
```

### Endpoints Status

| Endpoint | Correct MERGE(DBX,N8N)? | Notes |
|----------|----------------------|-------|
| GET /:workflowId | ✅ Fixed | |
| POST /:workflowId/run | ✅ Fixed | |
| PATCH /:workflowId | ❌ Uses @ProjectScope | Needs fix |
| DELETE /:workflowId | ❌ Uses @ProjectScope | Needs fix |
| POST /:workflowId/activate | ❌ Uses @ProjectScope | Needs fix |
| POST /:workflowId/deactivate | ❌ Uses @ProjectScope | Needs fix |
| POST /:workflowId/archive | ❌ Uses @ProjectScope | Needs fix |
| POST /:workflowId/unarchive | ❌ Uses @ProjectScope | Needs fix |
| PUT /:workflowId/share | ❌ Uses @ProjectScope | Needs fix |
| PUT /:workflowId/transfer | ❌ Uses @ProjectScope | Needs fix |

### Important Notes

- **Group permissions must use Databricks group IDs** (e.g., `8867436103593334`),
  not display names (e.g., `users`). The SCIM API returns group IDs, not names.
- **Service principals** authenticate with synthetic email
  `sp-{applicationId}@databricks.local`
- **PostgreSQL is used** (`DB_TYPE=postgresdb`), not SQLite

## Github Guidelines
- When creating a PR, use the conventions in
  `.github/pull_request_template.md` and
  `.github/pull_request_title_conventions.md`.
- Use `gh pr create --draft` to create draft PRs.
- Always reference the Linear ticket in the PR description,
  use `https://linear.app/n8n/issue/[TICKET-ID]`
- always link to the github issue if mentioned in the linear ticket.
