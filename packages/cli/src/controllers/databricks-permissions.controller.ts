import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { AuthenticatedRequest } from '@n8n/db';
import { Get, Param, Put, Query, RestController } from '@n8n/decorators';
import type { Response } from 'express';
import type { DatabricksSecurableType } from 'n8n-workflow';
import axios from 'axios';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { DatabricksPermissionService } from '@/services/databricks-permission.service';

interface GrantScopesDto {
	principalType: 'user' | 'group' | 'servicePrincipal';
	principalId: string;
	scopes: string[]; // n8n scope names (e.g., 'workflow:read', 'workflow:execute')
}

interface RevokeScopesDto {
	principalType: 'user' | 'group' | 'servicePrincipal';
	principalId: string;
	scopes?: string[]; // If omitted, revokes all scopes for the principal
}

interface DatabricksGroup {
	id: string;
	displayName: string;
	members?: Array<{ value: string; display: string }>;
}

interface DatabricksGroupsResponse {
	Resources: DatabricksGroup[];
	totalResults: number;
	startIndex: number;
	itemsPerPage: number;
}

interface DatabricksUser {
	id: string;
	userName: string;
	displayName?: string;
	emails?: Array<{ value: string; primary?: boolean }>;
	active?: boolean;
}

interface DatabricksUsersResponse {
	Resources: DatabricksUser[];
	totalResults: number;
	startIndex: number;
	itemsPerPage: number;
}

interface DatabricksServicePrincipal {
	id: string;
	applicationId: string;
	displayName?: string;
	active?: boolean;
}

interface DatabricksServicePrincipalsResponse {
	Resources: DatabricksServicePrincipal[];
	totalResults: number;
	startIndex: number;
	itemsPerPage: number;
}

// Cache TTL: 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
	data: T;
	expiresAt: number;
}

@RestController('/databricks')
export class DatabricksPermissionsController {
	// Caches keyed by Databricks token to ensure user-specific data
	private usersCache = new Map<
		string,
		CacheEntry<{
			users: Array<{ id: string; email: string; displayName: string }>;
			totalResults: number;
		}>
	>();
	private groupsCache = new Map<
		string,
		CacheEntry<{ groups: Array<{ id: string; displayName: string }>; totalResults: number }>
	>();
	private servicePrincipalsCache = new Map<
		string,
		CacheEntry<{
			servicePrincipals: Array<{ id: string; applicationId: string; displayName: string }>;
			totalResults: number;
		}>
	>();

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly permissionService: DatabricksPermissionService,
	) {}

	/**
	 * Check if Databricks RBAC is enabled
	 */
	private checkRbacEnabled(): void {
		if (!this.globalConfig.databricks.rbacEnabled) {
			throw new BadRequestError('Databricks RBAC is not enabled');
		}
	}

	/**
	 * Validate securable type
	 */
	private validateSecurableType(securableType: string): DatabricksSecurableType {
		const validTypes: DatabricksSecurableType[] = ['workflow', 'credential', 'data_table'];
		if (!validTypes.includes(securableType as DatabricksSecurableType)) {
			throw new BadRequestError(
				`Invalid securable type: ${securableType}. Valid types are: ${validTypes.join(', ')}`,
			);
		}
		return securableType as DatabricksSecurableType;
	}

	// ============================================================
	// Generic endpoints for any securable type
	// ============================================================

	/**
	 * Get permissions for any securable resource
	 */
	@Get('/permissions/:securableType/:securableId')
	async getSecurablePermissions(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('securableType') securableTypeParam: string,
		@Param('securableId') securableId: string,
	) {
		this.checkRbacEnabled();
		const securableType = this.validateSecurableType(securableTypeParam);
		const databricksToken = this.permissionService.getTokenFromRequest(req);

		const permissionGroups = await this.permissionService.getPermissionGroups(
			securableType,
			securableId,
		);
		const userScopes = await this.permissionService.getScopes(
			securableType,
			securableId,
			databricksToken,
		);
		const availableScopes = this.permissionService.getAvailableScopes(securableType);

		return {
			securableType,
			securableId,
			permissionGroups,
			currentUserScopes: userScopes,
			availableScopes: [...availableScopes],
			canManage: userScopes.includes(`${securableType}:share`),
		};
	}

	/**
	 * Grant scopes on any securable resource
	 */
	@Put('/permissions/:securableType/:securableId/grant')
	async grantSecurableScopes(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('securableType') securableTypeParam: string,
		@Param('securableId') securableId: string,
	) {
		this.checkRbacEnabled();
		const securableType = this.validateSecurableType(securableTypeParam);
		const databricksToken = this.permissionService.getTokenFromRequest(req);

		if (!databricksToken) {
			throw new BadRequestError('Databricks token not provided');
		}

		// Access body directly since @Body decorator requires Zod schema
		const body = req.body as GrantScopesDto | undefined;
		if (
			!body ||
			!body.principalType ||
			!body.principalId ||
			!body.scopes ||
			!Array.isArray(body.scopes)
		) {
			throw new BadRequestError(
				'Missing required fields: principalType, principalId, scopes (array)',
			);
		}

		if (body.scopes.length === 0) {
			throw new BadRequestError('At least one scope must be provided');
		}

		try {
			const userScopes = await this.permissionService.getScopes(
				securableType,
				securableId,
				databricksToken,
			);
			if (!userScopes.includes(`${securableType}:share`)) {
				throw new ForbiddenError('You do not have permission to manage this resource');
			}

			const permissionGroups = await this.permissionService.grantScopes(
				securableType,
				securableId,
				body.principalType,
				body.principalId,
				body.scopes,
			);

			return {
				success: true,
				permissionGroups,
				notification: {
					action: 'granted',
					securableType,
					securableId,
					principalType: body.principalType,
					principalId: body.principalId,
					scopes: body.scopes,
				},
			};
		} catch (error) {
			if (error instanceof Error && error.message.includes('permission')) {
				throw new ForbiddenError(error.message);
			}
			throw error;
		}
	}

	/**
	 * Revoke scopes on any securable resource
	 */
	@Put('/permissions/:securableType/:securableId/revoke')
	async revokeSecurableScopes(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('securableType') securableTypeParam: string,
		@Param('securableId') securableId: string,
	) {
		this.checkRbacEnabled();
		const securableType = this.validateSecurableType(securableTypeParam);
		const databricksToken = this.permissionService.getTokenFromRequest(req);

		if (!databricksToken) {
			throw new BadRequestError('Databricks token not provided');
		}

		// Access body directly since @Body decorator requires Zod schema
		const body = req.body as RevokeScopesDto | undefined;
		if (!body || !body.principalType || !body.principalId) {
			throw new BadRequestError('Missing required fields: principalType, principalId');
		}

		try {
			const userScopes = await this.permissionService.getScopes(
				securableType,
				securableId,
				databricksToken,
			);
			if (!userScopes.includes(`${securableType}:share`)) {
				throw new ForbiddenError('You do not have permission to manage this resource');
			}

			let permissionGroups;
			let revokedScopes: string[];
			if (body.scopes && Array.isArray(body.scopes) && body.scopes.length > 0) {
				// Revoke specific scopes
				permissionGroups = await this.permissionService.revokeScopes(
					securableType,
					securableId,
					body.principalType,
					body.principalId,
					body.scopes,
				);
				revokedScopes = body.scopes;
			} else {
				// Revoke all scopes for the principal
				permissionGroups = await this.permissionService.revokeAllScopes(
					securableType,
					securableId,
					body.principalType,
					body.principalId,
				);
				revokedScopes = ['all'];
			}

			return {
				success: true,
				permissionGroups,
				notification: {
					action: 'revoked',
					securableType,
					securableId,
					principalType: body.principalType,
					principalId: body.principalId,
					scopes: revokedScopes,
				},
			};
		} catch (error) {
			if (error instanceof Error && error.message.includes('permission')) {
				throw new ForbiddenError(error.message);
			}
			throw error;
		}
	}

	/**
	 * Set scopes for a principal (replaces all existing scopes)
	 */
	@Put('/permissions/:securableType/:securableId/set')
	async setSecurableScopes(
		req: AuthenticatedRequest,
		_res: Response,
		@Param('securableType') securableTypeParam: string,
		@Param('securableId') securableId: string,
	) {
		this.checkRbacEnabled();
		const securableType = this.validateSecurableType(securableTypeParam);
		const databricksToken = this.permissionService.getTokenFromRequest(req);

		if (!databricksToken) {
			throw new BadRequestError('Databricks token not provided');
		}

		// Access body directly since @Body decorator requires Zod schema
		const body = req.body as GrantScopesDto | undefined;
		if (
			!body ||
			!body.principalType ||
			!body.principalId ||
			!body.scopes ||
			!Array.isArray(body.scopes)
		) {
			throw new BadRequestError(
				'Missing required fields: principalType, principalId, scopes (array)',
			);
		}

		try {
			const userScopes = await this.permissionService.getScopes(
				securableType,
				securableId,
				databricksToken,
			);
			if (!userScopes.includes(`${securableType}:share`)) {
				throw new ForbiddenError('You do not have permission to manage this resource');
			}

			const permissionGroups = await this.permissionService.setScopes(
				securableType,
				securableId,
				body.principalType,
				body.principalId,
				body.scopes,
			);

			return {
				success: true,
				permissionGroups,
				notification: {
					action: 'set',
					securableType,
					securableId,
					principalType: body.principalType,
					principalId: body.principalId,
					scopes: body.scopes,
				},
			};
		} catch (error) {
			if (error instanceof Error && error.message.includes('permission')) {
				throw new ForbiddenError(error.message);
			}
			throw error;
		}
	}

	// ============================================================
	// Helper endpoints
	// ============================================================

	/**
	 * Fetch groups from Databricks workspace (cached for 5 minutes)
	 * Uses service principal credentials for SCIM API access.
	 * @see https://docs.databricks.com/api/workspace/groups/list
	 */
	@Get('/groups')
	async getDatabricksGroups(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query?: { filter?: string; startIndex?: string; count?: string },
	) {
		this.checkRbacEnabled();

		// Check cache for unfiltered requests
		const cacheKey = 'default';
		if (!query?.filter && !query?.startIndex && !query?.count) {
			const cached = this.groupsCache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				return cached.data;
			}
		}

		try {
			const serviceToken = await this.permissionService.getServiceToken();

			const params = new URLSearchParams();
			if (query?.filter) params.append('filter', query.filter);
			if (query?.startIndex !== undefined) params.append('startIndex', query.startIndex);
			if (query?.count !== undefined) params.append('count', query.count);

			const url = this.permissionService.getScimUrl('Groups', params);

			const response = await axios.get<DatabricksGroupsResponse>(url, {
				headers: {
					Authorization: `Bearer ${serviceToken}`,
				},
			});

			const result = {
				groups: response.data.Resources.map((g) => ({
					id: g.id,
					displayName: g.displayName,
				})),
				totalResults: response.data.totalResults,
			};

			// Cache unfiltered results
			if (!query?.filter && !query?.startIndex && !query?.count) {
				this.groupsCache.set(cacheKey, {
					data: result,
					expiresAt: Date.now() + CACHE_TTL_MS,
				});
			}

			return result;
		} catch (error) {
			const axiosError = error as {
				response?: { status: number; data: unknown };
				message?: string;
			};
			this.logger.error('Failed to fetch groups from Databricks', {
				error: axiosError.message,
				status: axiosError.response?.status,
				data: axiosError.response?.data,
			});
			const databricksError = JSON.stringify(axiosError.response?.data ?? axiosError.message);
			throw new BadRequestError(
				`Failed to fetch groups from Databricks: ${axiosError.response?.status} - ${databricksError}`,
			);
		}
	}

	/**
	 * Fetch users from Databricks workspace (cached for 5 minutes)
	 * Uses service principal credentials for SCIM API access.
	 * @see https://docs.databricks.com/api/workspace/users/list
	 */
	@Get('/users')
	async getDatabricksUsers(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query?: { filter?: string; startIndex?: string; count?: string },
	) {
		this.checkRbacEnabled();

		// Check cache for unfiltered requests
		const cacheKey = 'default';
		if (!query?.filter && !query?.startIndex && !query?.count) {
			const cached = this.usersCache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				return cached.data;
			}
		}

		try {
			const serviceToken = await this.permissionService.getServiceToken();

			const params = new URLSearchParams();
			if (query?.filter) params.append('filter', query.filter);
			if (query?.startIndex !== undefined) params.append('startIndex', query.startIndex);
			if (query?.count !== undefined) params.append('count', query.count);

			const url = this.permissionService.getScimUrl('Users', params);

			const response = await axios.get<DatabricksUsersResponse>(url, {
				headers: {
					Authorization: `Bearer ${serviceToken}`,
				},
			});

			const result = {
				users: response.data.Resources.map((u) => ({
					id: u.id, // Databricks SCIM user ID for permission assignment
					email: u.userName,
					displayName: u.displayName || u.userName,
				})),
				totalResults: response.data.totalResults,
			};

			// Cache unfiltered results
			if (!query?.filter && !query?.startIndex && !query?.count) {
				this.usersCache.set(cacheKey, {
					data: result,
					expiresAt: Date.now() + CACHE_TTL_MS,
				});
			}

			return result;
		} catch (error) {
			const axiosError = error as {
				response?: { status: number; data: unknown };
				message?: string;
			};
			this.logger.error('Failed to fetch users from Databricks', {
				error: axiosError.message,
				status: axiosError.response?.status,
				data: axiosError.response?.data,
			});
			const databricksError = JSON.stringify(axiosError.response?.data ?? axiosError.message);
			throw new BadRequestError(
				`Failed to fetch users from Databricks: ${axiosError.response?.status} - ${databricksError}`,
			);
		}
	}

	/**
	 * Fetch service principals from Databricks workspace (cached for 5 minutes)
	 * Uses service principal credentials for SCIM API access.
	 * @see https://docs.databricks.com/api/workspace/serviceprincipals/list
	 */
	@Get('/service-principals')
	async getDatabricksServicePrincipals(
		_req: AuthenticatedRequest,
		_res: Response,
		@Query query?: { filter?: string; startIndex?: string; count?: string },
	) {
		this.checkRbacEnabled();

		// Check cache for unfiltered requests
		const cacheKey = 'default';
		if (!query?.filter && !query?.startIndex && !query?.count) {
			const cached = this.servicePrincipalsCache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				return cached.data;
			}
		}

		try {
			const serviceToken = await this.permissionService.getServiceToken();

			const params = new URLSearchParams();
			if (query?.filter) params.append('filter', query.filter);
			if (query?.startIndex !== undefined) params.append('startIndex', query.startIndex);
			if (query?.count !== undefined) params.append('count', query.count);

			const url = this.permissionService.getScimUrl('ServicePrincipals', params);

			const response = await axios.get<DatabricksServicePrincipalsResponse>(url, {
				headers: {
					Authorization: `Bearer ${serviceToken}`,
				},
			});

			const result = {
				servicePrincipals: response.data.Resources.map((sp) => ({
					id: sp.id, // Databricks SCIM service principal ID for permission assignment
					applicationId: sp.applicationId,
					displayName: sp.displayName || sp.applicationId,
				})),
				totalResults: response.data.totalResults,
			};

			// Cache unfiltered results
			if (!query?.filter && !query?.startIndex && !query?.count) {
				this.servicePrincipalsCache.set(cacheKey, {
					data: result,
					expiresAt: Date.now() + CACHE_TTL_MS,
				});
			}

			return result;
		} catch (error) {
			const axiosError = error as {
				response?: { status: number; data: unknown };
				message?: string;
			};
			this.logger.error('Failed to fetch service principals from Databricks', {
				error: axiosError.message,
				status: axiosError.response?.status,
				data: axiosError.response?.data,
			});
			const databricksError = JSON.stringify(axiosError.response?.data ?? axiosError.message);
			throw new BadRequestError(
				`Failed to fetch service principals from Databricks: ${axiosError.response?.status} - ${databricksError}`,
			);
		}
	}

	/**
	 * Get current user's Databricks info including groups
	 */
	@Get('/me')
	async getDatabricksCurrentUser(req: AuthenticatedRequest, _res: Response) {
		this.checkRbacEnabled();

		const databricksToken = this.permissionService.getTokenFromRequest(req);
		if (!databricksToken) {
			throw new BadRequestError('Databricks token not provided');
		}

		try {
			const userData = await this.permissionService.fetchCurrentUser(databricksToken);

			return {
				id: userData.id,
				userName: userData.userName,
				displayName: userData.displayName,
				groups:
					userData.groups?.map((g) => ({
						id: g.value,
						displayName: g.display,
					})) ?? [],
			};
		} catch (error) {
			this.logger.error('Failed to fetch current user from Databricks', { error });
			throw new BadRequestError('Failed to fetch user info from Databricks');
		}
	}
}
