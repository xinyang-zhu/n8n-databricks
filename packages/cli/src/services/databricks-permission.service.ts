import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { DatabricksSecurablePermissionRepository } from '@n8n/db';
import type { DatabricksPermissionGroup, DatabricksSecurableType } from 'n8n-workflow';
import { DATABRICKS_SECURABLE_SCOPES } from 'n8n-workflow';
import axios from 'axios';

/**
 * Service for managing Databricks permissions on securable resources.
 * Uses n8n scope names directly (e.g., 'workflow:read', 'workflow:execute').
 * Permissions are additive: MERGE(DBX, N8N) = union of scopes from both systems.
 */
@Service()
export class DatabricksPermissionService {
	// Cache identity by token - if token changes, cache miss, fresh fetch
	private identityCache = new Map<string, { identity: DatabricksIdentity; expiresAt: number }>();
	// Cache principal info (id => displayName) for UI display
	private principalCache = new Map<string, { id: string; displayName: string; type: string }>();
	// Cache for service principal token (used for listing users/groups/service-principals)
	private serviceTokenCache: { token: string; expiresAt: number } | null = null;
	private readonly IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly permissionRepository: DatabricksSecurablePermissionRepository,
	) {}

	// ============================================================
	// Host and URL helpers - Single source of truth for Databricks URLs
	// ============================================================

	/**
	 * Get the Databricks host without protocol.
	 * Single source of truth - DO NOT duplicate this logic elsewhere.
	 */
	getDatabricksHost(): string {
		const host = this.globalConfig.databricks.host;
		if (!host) {
			throw new Error('Databricks host not configured');
		}
		return host.replace(/^https?:\/\//, '');
	}

	/**
	 * Get the base URL for Databricks SCIM API.
	 */
	getScimBaseUrl(): string {
		return `https://${this.getDatabricksHost()}/api/2.0/preview/scim/v2`;
	}

	/**
	 * Construct a full SCIM API URL for the given endpoint.
	 * @param endpoint - The SCIM endpoint (e.g., 'Me', 'Users', 'Groups', 'ServicePrincipals')
	 * @param params - Optional URLSearchParams to append
	 */
	getScimUrl(endpoint: string, params?: URLSearchParams): string {
		const baseUrl = `${this.getScimBaseUrl()}/${endpoint}`;
		if (params && params.toString()) {
			return `${baseUrl}?${params.toString()}`;
		}
		return baseUrl;
	}

	/**
	 * Get a service principal token for SCIM API calls.
	 * Uses OAuth2 client credentials flow with DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET.
	 * Token is cached until expiration.
	 */
	async getServiceToken(): Promise<string> {
		// Check cache first
		if (this.serviceTokenCache && this.serviceTokenCache.expiresAt > Date.now()) {
			return this.serviceTokenCache.token;
		}

		const { clientId, clientSecret } = this.globalConfig.databricks;
		if (!clientId || !clientSecret) {
			throw new Error(
				'DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET must be configured for SCIM API access',
			);
		}

		const tokenUrl = `https://${this.getDatabricksHost()}/oidc/v1/token`;

		try {
			const response = await axios.post<{ access_token: string; expires_in: number }>(
				tokenUrl,
				new URLSearchParams({
					grant_type: 'client_credentials',
					scope: 'all-apis',
				}).toString(),
				{
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					auth: {
						username: clientId,
						password: clientSecret,
					},
				},
			);

			const { access_token, expires_in } = response.data;

			// Cache the token (expire 1 minute early to avoid edge cases)
			this.serviceTokenCache = {
				token: access_token,
				expiresAt: Date.now() + (expires_in - 60) * 1000,
			};

			this.logger.debug('[DBX-TOKEN] Service token acquired', {
				expiresIn: expires_in,
			});

			return access_token;
		} catch (error) {
			const axiosError = error as {
				response?: { status: number; data: unknown };
				message?: string;
			};
			this.logger.error('Failed to acquire service token', {
				error: axiosError.message,
				status: axiosError.response?.status,
				data: axiosError.response?.data,
			});
			throw new Error(
				`Failed to acquire Databricks service token: ${axiosError.response?.status ?? axiosError.message}`,
			);
		}
	}

	// ============================================================
	// Token management
	// ============================================================

	/**
	 * Extract Databricks token from request.
	 *
	 * Checks in order:
	 * 1. databricks_token cookie (user logged in via UI with token)
	 * 2. x-forwarded-access-token header (UI via reverse proxy)
	 * 3. x-forwarded-token header (API via reverse proxy)
	 */
	getTokenFromRequest(req: {
		headers: Record<string, unknown>;
		cookies?: Record<string, string | undefined>;
	}): string | undefined {
		const cookieToken = req.cookies?.databricks_token;
		const forwardedAccessToken = req.headers['x-forwarded-access-token'] as string | undefined;
		const forwardedToken = req.headers['x-forwarded-token'] as string | undefined;

		// Cookie takes precedence - it represents user's explicit login choice
		return cookieToken || forwardedAccessToken || forwardedToken;
	}

	/**
	 * Get the source of the Databricks token (for logging/debugging).
	 */
	getTokenSourceFromRequest(req: {
		headers: Record<string, unknown>;
		cookies?: Record<string, string | undefined>;
	}): 'cookie' | 'x-forwarded-access-token' | 'x-forwarded-token' | 'none' {
		if (req.cookies?.databricks_token) return 'cookie';
		if (req.headers['x-forwarded-access-token']) return 'x-forwarded-access-token';
		if (req.headers['x-forwarded-token']) return 'x-forwarded-token';
		return 'none';
	}

	/**
	 * Get available scopes for a securable type
	 */
	getAvailableScopes(securableType: DatabricksSecurableType): readonly string[] {
		return DATABRICKS_SECURABLE_SCOPES[securableType] ?? [];
	}

	/**
	 * Check if a scope is valid for a securable type
	 */
	isValidScope(securableType: DatabricksSecurableType, scope: string): boolean {
		return this.getAvailableScopes(securableType).includes(scope);
	}

	/**
	 * Get all permission groups for a securable resource.
	 * Returns principals with their granted scopes and display names from cache.
	 */
	async getPermissionGroups(
		securableType: DatabricksSecurableType,
		securableId: string,
	): Promise<DatabricksPermissionGroup[]> {
		const permissions = await this.permissionRepository.findBySecurable(securableType, securableId);

		// Group by principal, collecting all scopes
		const groupMap = new Map<string, DatabricksPermissionGroup>();
		for (const perm of permissions) {
			const key = `${perm.principalType}:${perm.principalId}`;
			if (!groupMap.has(key)) {
				// Look up display name from cache
				const cachedPrincipal = this.principalCache.get(perm.principalId);
				groupMap.set(key, {
					principal: {
						type: perm.principalType as 'user' | 'group' | 'servicePrincipal',
						id: perm.principalId,
						displayName: cachedPrincipal?.displayName,
					},
					scopes: [],
				});
			}
			const group = groupMap.get(key)!;
			if (!group.scopes.includes(perm.permission)) {
				group.scopes.push(perm.permission);
			}
		}

		return Array.from(groupMap.values());
	}

	/**
	 * Get all scopes a user has on a securable via Databricks permissions.
	 * Checks user ID and group memberships.
	 */
	async getScopes(
		securableType: DatabricksSecurableType,
		securableId: string,
		databricksToken?: string,
	): Promise<string[]> {
		if (!databricksToken) {
			return [];
		}

		const permissions = await this.permissionRepository.findBySecurable(securableType, securableId);
		if (permissions.length === 0) {
			return [];
		}

		const identity = await this.getDatabricksIdentity(databricksToken);
		const scopes = new Set<string>();

		for (const perm of permissions) {
			const matches =
				(perm.principalType === 'user' && perm.principalId === identity.userId) ||
				(perm.principalType === 'group' && identity.groupIds.includes(perm.principalId)) ||
				(perm.principalType === 'servicePrincipal' && perm.principalId === identity.userId);

			if (matches) {
				scopes.add(perm.permission);
			}
		}

		return Array.from(scopes);
	}

	/**
	 * Check if user has a specific scope on a securable
	 */
	async hasScope(
		securableType: DatabricksSecurableType,
		securableId: string,
		requiredScope: string,
		databricksToken?: string,
	): Promise<boolean> {
		const scopes = await this.getScopes(securableType, securableId, databricksToken);
		return scopes.includes(requiredScope);
	}

	/**
	 * Check if user has any of the specified scopes
	 */
	async hasAnyScope(
		securableType: DatabricksSecurableType,
		securableId: string,
		requiredScopes: string[],
		databricksToken?: string,
	): Promise<boolean> {
		const scopes = await this.getScopes(securableType, securableId, databricksToken);
		return requiredScopes.some((s) => scopes.includes(s));
	}

	/**
	 * Fetch current user info from Databricks SCIM /Me endpoint.
	 * Single source of truth for all /Me calls - DO NOT duplicate this logic elsewhere.
	 */
	async fetchCurrentUser(databricksToken: string): Promise<DatabricksCurrentUserResponse> {
		const response = await axios.get<DatabricksCurrentUserResponse>(this.getScimUrl('Me'), {
			headers: {
				Authorization: `Bearer ${databricksToken}`,
			},
		});
		return response.data;
	}

	/**
	 * Get current user's Databricks SCIM ID from their token.
	 */
	async getCurrentUserDatabricksId(databricksToken: string): Promise<string> {
		const identity = await this.getDatabricksIdentity(databricksToken);
		return identity.userId;
	}

	/**
	 * Get Databricks identity (user ID and group IDs) from token.
	 * Cached by token - different token = fresh fetch.
	 */
	async getDatabricksIdentity(
		databricksToken: string,
		tokenSource?: 'cookie' | 'header' | 'none',
	): Promise<DatabricksIdentity> {
		const sourceInfo = tokenSource ? `, source=${tokenSource}` : '';

		// Check cache - keyed by token, so different token = cache miss
		const cached = this.identityCache.get(databricksToken);
		if (cached && cached.expiresAt > Date.now()) {
			this.logger.info(
				`[Databricks RBAC] Identified principal (cached): id=${cached.identity.userId}, groups=${cached.identity.groupIds.length}${sourceInfo}`,
			);
			return cached.identity;
		}

		try {
			const userData = await this.fetchCurrentUser(databricksToken);

			const identity: DatabricksIdentity = {
				userId: userData.id,
				displayName: userData.displayName,
				groupIds: userData.groups?.map((g) => g.value) ?? [],
			};

			this.logger.info(
				`[Databricks RBAC] Identified principal: id=${userData.id}, userName=${userData.userName}, displayName=${userData.displayName}, groups=${identity.groupIds.length}${sourceInfo}`,
			);

			// Cache by token
			this.identityCache.set(databricksToken, {
				identity,
				expiresAt: Date.now() + this.IDENTITY_CACHE_TTL_MS,
			});

			// Cache principal info for display name lookup
			this.principalCache.set(userData.id, {
				id: userData.id,
				displayName: userData.displayName ?? userData.userName,
				type: 'user',
			});

			return identity;
		} catch (error) {
			const axiosError = error as {
				response?: { status: number; data: unknown };
				message?: string;
			};
			this.logger.error('Failed to fetch Databricks identity', {
				error: axiosError.message,
				status: axiosError.response?.status,
			});
			throw new Error(
				`Failed to fetch Databricks identity: ${axiosError.response?.status ?? axiosError.message}`,
			);
		}
	}

	/**
	 * Grant scopes to a principal on a securable.
	 * Multiple scopes can be granted at once.
	 */
	async grantScopes(
		securableType: DatabricksSecurableType,
		securableId: string,
		principalType: 'user' | 'group' | 'servicePrincipal',
		principalId: string,
		scopes: string[],
		principalDisplayName?: string,
	): Promise<DatabricksPermissionGroup[]> {
		// Validate all scopes
		for (const scope of scopes) {
			if (!this.isValidScope(securableType, scope)) {
				throw new Error(`Scope '${scope}' is not valid for securable type '${securableType}'`);
			}
		}

		// Cache the display name if provided
		if (principalDisplayName) {
			this.principalCache.set(principalId, {
				id: principalId,
				displayName: principalDisplayName,
				type: principalType,
			});
		}

		// Insert each scope as a separate row
		for (const scope of scopes) {
			await this.permissionRepository.upsertPermission(
				securableType,
				securableId,
				principalType,
				principalId,
				scope,
			);
		}

		this.logger.info(
			`[Databricks RBAC] Granted scopes: ${securableType}/${securableId} -> ${principalType}:${principalId} (${principalDisplayName ?? 'unknown'}) = [${scopes.join(', ')}]`,
		);

		return await this.getPermissionGroups(securableType, securableId);
	}

	/**
	 * Set scopes for a principal (replaces existing scopes)
	 */
	async setScopes(
		securableType: DatabricksSecurableType,
		securableId: string,
		principalType: 'user' | 'group' | 'servicePrincipal',
		principalId: string,
		scopes: string[],
	): Promise<DatabricksPermissionGroup[]> {
		// Validate all scopes
		for (const scope of scopes) {
			if (!this.isValidScope(securableType, scope)) {
				throw new Error(`Scope '${scope}' is not valid for securable type '${securableType}'`);
			}
		}

		// Delete all existing scopes for this principal
		await this.permissionRepository.deleteAllForPrincipal(
			securableType,
			securableId,
			principalType,
			principalId,
		);

		// Insert new scopes
		for (const scope of scopes) {
			await this.permissionRepository.upsertPermission(
				securableType,
				securableId,
				principalType,
				principalId,
				scope,
			);
		}

		this.logger.info('[Databricks RBAC] Set scopes', {
			action: 'set',
			securableType,
			securableId,
			principalType,
			principalId,
			newScopes: scopes,
		});

		return await this.getPermissionGroups(securableType, securableId);
	}

	/**
	 * Revoke specific scopes from a principal
	 */
	async revokeScopes(
		securableType: DatabricksSecurableType,
		securableId: string,
		principalType: 'user' | 'group' | 'servicePrincipal',
		principalId: string,
		scopes: string[],
	): Promise<DatabricksPermissionGroup[]> {
		for (const scope of scopes) {
			await this.permissionRepository.deletePermission(
				securableType,
				securableId,
				principalType,
				principalId,
				scope,
			);
		}

		this.logger.info('[Databricks RBAC] Revoked scopes', {
			action: 'revoke',
			securableType,
			securableId,
			principalType,
			principalId,
			revokedScopes: scopes,
		});

		return await this.getPermissionGroups(securableType, securableId);
	}

	/**
	 * Revoke all scopes from a principal
	 */
	async revokeAllScopes(
		securableType: DatabricksSecurableType,
		securableId: string,
		principalType: 'user' | 'group' | 'servicePrincipal',
		principalId: string,
	): Promise<DatabricksPermissionGroup[]> {
		await this.permissionRepository.deleteAllForPrincipal(
			securableType,
			securableId,
			principalType,
			principalId,
		);

		this.logger.info('[Databricks RBAC] Revoked all scopes', {
			action: 'revokeAll',
			securableType,
			securableId,
			principalType,
			principalId,
		});

		return await this.getPermissionGroups(securableType, securableId);
	}

	/**
	 * Get all securable IDs that the user has access to via Databricks permissions.
	 * Returns IDs where the user has any scope (or optionally a specific required scope).
	 */
	async getAccessibleSecurableIds(
		securableType: DatabricksSecurableType,
		databricksToken: string,
		requiredScope?: string,
	): Promise<string[]> {
		if (!this.globalConfig.databricks.rbacEnabled) {
			return [];
		}

		try {
			const identity = await this.getDatabricksIdentity(databricksToken);

			// Get all permissions for this securable type
			const allPermissions = await this.permissionRepository.find({
				where: { securableType },
			});

			const accessibleIds = new Set<string>();

			for (const perm of allPermissions) {
				// Skip if a specific scope is required and doesn't match
				if (requiredScope && perm.permission !== requiredScope) {
					continue;
				}

				const matches =
					(perm.principalType === 'user' && perm.principalId === identity.userId) ||
					(perm.principalType === 'group' && identity.groupIds.includes(perm.principalId)) ||
					(perm.principalType === 'servicePrincipal' && perm.principalId === identity.userId);

				if (matches) {
					accessibleIds.add(perm.securableId);
				}
			}

			return Array.from(accessibleIds);
		} catch (error) {
			this.logger.error('Failed to get accessible securable IDs', {
				securableType,
				error: (error as Error).message,
			});
			return [];
		}
	}
}

export interface DatabricksIdentity {
	userId: string;
	displayName?: string;
	groupIds: string[];
}

export interface DatabricksCurrentUserResponse {
	id: string;
	userName: string;
	displayName?: string;
	emails?: Array<{ value: string; primary?: boolean }>;
	groups?: Array<{ value: string; display: string; $ref?: string }>;
	// Service principals have applicationId, users don't
	applicationId?: string;
}
