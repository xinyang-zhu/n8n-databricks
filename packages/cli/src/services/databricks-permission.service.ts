import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import type { User } from '@n8n/db';
import { DatabricksSecurablePermissionRepository } from '@n8n/db';
import type { DatabricksPermissionGroup, DatabricksSecurableType } from 'n8n-workflow';
import { DATABRICKS_SECURABLE_SCOPES } from 'n8n-workflow';
import axios from 'axios';

/**
 * Legacy permission to new scope mapping.
 * USE = read + execute
 * MANAGE = all scopes
 */
const LEGACY_SCOPE_MAPPING: Record<string, Record<string, string[]>> = {
	workflow: {
		READ: ['workflow:read'],
		USE: ['workflow:read', 'workflow:execute'],
		WRITE: ['workflow:read', 'workflow:update', 'workflow:execute'],
		MANAGE: [
			'workflow:read',
			'workflow:update',
			'workflow:delete',
			'workflow:execute',
			'workflow:share',
			'workflow:move',
			'workflow:activate',
			'workflow:deactivate',
			'workflow:publish',
		],
	},
	credential: {
		READ: ['credential:read'],
		USE: ['credential:read'],
		WRITE: ['credential:read', 'credential:update'],
		MANAGE: [
			'credential:read',
			'credential:update',
			'credential:delete',
			'credential:share',
			'credential:move',
		],
	},
	data_table: {
		READ: ['dataTable:read', 'dataTable:readRow'],
		USE: ['dataTable:read', 'dataTable:readRow'],
		WRITE: ['dataTable:read', 'dataTable:update', 'dataTable:readRow', 'dataTable:writeRow'],
		MANAGE: [
			'dataTable:read',
			'dataTable:update',
			'dataTable:delete',
			'dataTable:readRow',
			'dataTable:writeRow',
		],
	},
};

/**
 * Service for managing Databricks permissions on securable resources.
 * Uses n8n scope names directly (e.g., 'workflow:read', 'workflow:execute').
 * Permissions are additive: MERGE(DBX, N8N) = union of scopes from both systems.
 */
@Service()
export class DatabricksPermissionService {
	private identityCache = new Map<string, { identity: DatabricksIdentity; expiresAt: number }>();
	private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly permissionRepository: DatabricksSecurablePermissionRepository,
	) {}

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
	 * Convert legacy permission (USE, MANAGE, etc.) to new scope format.
	 * Returns the input scope if it's not a legacy permission.
	 */
	private convertLegacyScope(securableType: DatabricksSecurableType, scope: string): string[] {
		const mapping = LEGACY_SCOPE_MAPPING[securableType];
		if (mapping && mapping[scope]) {
			return mapping[scope];
		}
		// If it's already a valid new scope, return it as-is
		if (this.isValidScope(securableType, scope)) {
			return [scope];
		}
		// Unknown scope, return empty (or could return as-is)
		return [];
	}

	/**
	 * Get all permission groups for a securable resource.
	 * Returns principals with their granted scopes.
	 * Legacy permissions (USE, MANAGE) are converted to new scope format.
	 */
	async getPermissionGroups(
		securableType: DatabricksSecurableType,
		securableId: string,
	): Promise<DatabricksPermissionGroup[]> {
		const permissions = await this.permissionRepository.findBySecurable(securableType, securableId);

		// Group by principal, collecting all scopes (with legacy conversion)
		const groupMap = new Map<string, DatabricksPermissionGroup>();
		for (const perm of permissions) {
			const key = `${perm.principalType}:${perm.principalId}`;
			if (!groupMap.has(key)) {
				groupMap.set(key, {
					principal: {
						type: perm.principalType as 'user' | 'group' | 'servicePrincipal',
						id: perm.principalId,
					},
					scopes: [],
				});
			}
			// Convert legacy scope to new format
			const convertedScopes = this.convertLegacyScope(securableType, perm.permission);
			const group = groupMap.get(key)!;
			for (const scope of convertedScopes) {
				if (!group.scopes.includes(scope)) {
					group.scopes.push(scope);
				}
			}
		}

		return Array.from(groupMap.values());
	}

	/**
	 * Get all scopes a user has on a securable via Databricks permissions.
	 * Checks user ID and group memberships.
	 * Legacy permissions (USE, MANAGE) are converted to new scope format.
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
				// Convert legacy scope to new format
				const convertedScopes = this.convertLegacyScope(securableType, perm.permission);
				for (const scope of convertedScopes) {
					scopes.add(scope);
				}
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
	 * Get current user's Databricks SCIM ID from their token.
	 */
	async getCurrentUserDatabricksId(databricksToken: string): Promise<string> {
		const identity = await this.getDatabricksIdentity(databricksToken);
		return identity.userId;
	}

	/**
	 * Get Databricks identity (user ID and group IDs) from token.
	 * Results are cached for 5 minutes.
	 */
	async getDatabricksIdentity(databricksToken: string): Promise<DatabricksIdentity> {
		// Check cache first
		const cached = this.identityCache.get(databricksToken);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.identity;
		}

		const databricksHostRaw = this.globalConfig.databricks.host;
		if (!databricksHostRaw) {
			throw new Error('Databricks host not configured');
		}
		const databricksHost = databricksHostRaw.replace(/^https?:\/\//, '');

		try {
			const response = await axios.get<DatabricksCurrentUserResponse>(
				`https://${databricksHost}/api/2.0/preview/scim/v2/Me`,
				{
					headers: {
						Authorization: `Bearer ${databricksToken}`,
					},
				},
			);

			const identity: DatabricksIdentity = {
				userId: response.data.id,
				groupIds: response.data.groups?.map((g) => g.value) ?? [],
			};

			// Cache the result
			this.identityCache.set(databricksToken, {
				identity,
				expiresAt: Date.now() + this.CACHE_TTL_MS,
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
	): Promise<DatabricksPermissionGroup[]> {
		// Validate all scopes
		for (const scope of scopes) {
			if (!this.isValidScope(securableType, scope)) {
				throw new Error(`Scope '${scope}' is not valid for securable type '${securableType}'`);
			}
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

		return await this.getPermissionGroups(securableType, securableId);
	}

	/**
	 * Get all securable IDs that the user has access to via Databricks permissions.
	 * Returns IDs where the user has any scope (or optionally a specific required scope).
	 * Legacy permissions (USE, MANAGE) are converted when checking required scope.
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
				// Convert legacy scope to new format for comparison
				const convertedScopes = this.convertLegacyScope(securableType, perm.permission);

				// Skip if a specific scope is required and not in converted scopes
				if (requiredScope && !convertedScopes.includes(requiredScope)) {
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

	/**
	 * Clear the identity cache
	 */
	clearCache(databricksToken?: string): void {
		if (databricksToken) {
			this.identityCache.delete(databricksToken);
		} else {
			this.identityCache.clear();
		}
	}

	// ============================================================
	// DEPRECATED: Legacy methods for backwards compatibility
	// These will be removed in a future version
	// ============================================================

	/** @deprecated Use hasScope() instead */
	async hasPermission(
		securableType: DatabricksSecurableType,
		securableId: string,
		_user: User,
		requiredScope: string,
		databricksToken?: string,
	): Promise<boolean> {
		return await this.hasScope(securableType, securableId, requiredScope, databricksToken);
	}

	/** @deprecated Use getScopes() instead */
	async getHighestPermission(
		securableType: DatabricksSecurableType,
		securableId: string,
		_user: User,
		databricksToken?: string,
	): Promise<string | null> {
		const scopes = await this.getScopes(securableType, securableId, databricksToken);
		return scopes.length > 0 ? scopes[0] : null;
	}
}

interface DatabricksIdentity {
	userId: string;
	groupIds: string[];
}

interface DatabricksCurrentUserResponse {
	id: string;
	userName: string;
	displayName?: string;
	emails?: Array<{ value: string; primary?: boolean }>;
	groups?: Array<{ value: string; display: string; $ref?: string }>;
}
