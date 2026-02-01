import { Config, Env } from '../decorators';

@Config
export class DatabricksConfig {
	/** Databricks workspace host (e.g., your-workspace.cloud.databricks.com) */
	@Env('DATABRICKS_HOST')
	host: string = '';

	/** Enable Databricks federated login (via reverse proxy with x-forwarded-access-token) */
	@Env('N8N_AUTH_DATABRICKS_FEDERATED_ENABLED')
	federatedLoginEnabled: boolean = false;

	/** Enable Databricks token login (user provides their PAT) */
	@Env('N8N_AUTH_DATABRICKS_TOKEN_ENABLED')
	tokenLoginEnabled: boolean = false;

	/** Enable Databricks RBAC for workflows, credentials, and data tables */
	@Env('N8N_DATABRICKS_RBAC_ENABLED')
	rbacEnabled: boolean = true;

	/** Service principal client ID for SCIM API calls (listing users/groups/service-principals) */
	@Env('DATABRICKS_CLIENT_ID')
	clientId: string = '';

	/** Service principal client secret for SCIM API calls */
	@Env('DATABRICKS_CLIENT_SECRET')
	clientSecret: string = '';
}

@Config
export class AuthMethodsConfig {
	/** Enable email/password login */
	@Env('N8N_AUTH_EMAIL_ENABLED')
	emailEnabled: boolean = true;

	/** Enable user sign-up (first user becomes owner, subsequent users need invite) */
	@Env('N8N_AUTH_SIGNUP_ENABLED')
	signupEnabled: boolean = true;
}
