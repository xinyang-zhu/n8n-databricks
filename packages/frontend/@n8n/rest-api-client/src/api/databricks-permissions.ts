import type { DatabricksPermissionGroup, DatabricksSecurableType } from 'n8n-workflow';

import type { IRestApiContext } from '../types';
import { makeRestApiRequest } from '../utils';

export interface DatabricksUser {
	id: string;
	email: string;
	displayName: string;
}

export interface DatabricksGroup {
	id: string;
	displayName: string;
}

export interface DatabricksServicePrincipal {
	id: string;
	applicationId: string;
	displayName: string;
}

/**
 * Response for getting permissions on any securable (scope-based)
 */
export interface SecurablePermissionsResponse {
	securableType: DatabricksSecurableType;
	securableId: string;
	permissionGroups: DatabricksPermissionGroup[];
	currentUserScopes: string[]; // n8n scope names (e.g., 'workflow:read', 'workflow:execute')
	availableScopes: string[]; // All valid scopes for this securable type
	canManage: boolean;
}

export interface PermissionNotification {
	action: 'granted' | 'revoked' | 'set';
	securableType: DatabricksSecurableType;
	securableId: string;
	principalType: 'user' | 'group' | 'servicePrincipal';
	principalId: string;
	scopes: string[];
}

export interface GrantRevokeResponse {
	success: boolean;
	permissionGroups: DatabricksPermissionGroup[];
	notification?: PermissionNotification;
}

export interface DatabricksGroupsResponse {
	groups: DatabricksGroup[];
	totalResults: number;
}

export interface DatabricksServicePrincipalsResponse {
	servicePrincipals: DatabricksServicePrincipal[];
	totalResults: number;
}

export interface DatabricksUsersResponse {
	users: DatabricksUser[];
	totalResults: number;
}

export interface DatabricksCurrentUserResponse {
	id: string;
	userName: string;
	displayName: string;
	groups: DatabricksGroup[];
}

/**
 * Get permissions for a securable resource
 */
export async function getSecurablePermissions(
	context: IRestApiContext,
	securableType: DatabricksSecurableType,
	securableId: string,
): Promise<SecurablePermissionsResponse> {
	return await makeRestApiRequest(
		context,
		'GET',
		`/databricks/permissions/${securableType}/${securableId}`,
	);
}

/**
 * Grant scopes to a user, group, or service principal on a securable resource
 */
export async function grantSecurableScopes(
	context: IRestApiContext,
	securableType: DatabricksSecurableType,
	securableId: string,
	principalType: 'user' | 'group' | 'servicePrincipal',
	principalId: string,
	scopes: string[],
	principalDisplayName?: string,
): Promise<GrantRevokeResponse> {
	return await makeRestApiRequest(
		context,
		'PUT',
		`/databricks/permissions/${securableType}/${securableId}/grant`,
		{ principalType, principalId, scopes, principalDisplayName },
	);
}

/**
 * Set scopes for a principal (replaces all existing scopes)
 */
export async function setSecurableScopes(
	context: IRestApiContext,
	securableType: DatabricksSecurableType,
	securableId: string,
	principalType: 'user' | 'group' | 'servicePrincipal',
	principalId: string,
	scopes: string[],
): Promise<GrantRevokeResponse> {
	return await makeRestApiRequest(
		context,
		'PUT',
		`/databricks/permissions/${securableType}/${securableId}/set`,
		{ principalType, principalId, scopes },
	);
}

/**
 * Revoke scopes from a user, group, or service principal on a securable resource
 * If scopes array is empty or not provided, revokes all scopes
 */
export async function revokeSecurableScopes(
	context: IRestApiContext,
	securableType: DatabricksSecurableType,
	securableId: string,
	principalType: 'user' | 'group' | 'servicePrincipal',
	principalId: string,
	scopes?: string[],
): Promise<GrantRevokeResponse> {
	return await makeRestApiRequest(
		context,
		'PUT',
		`/databricks/permissions/${securableType}/${securableId}/revoke`,
		{ principalType, principalId, scopes },
	);
}

/**
 * Get groups from Databricks workspace (cached in backend for 5 minutes)
 */
export async function getDatabricksGroups(
	context: IRestApiContext,
	filter?: string,
): Promise<DatabricksGroupsResponse> {
	const params = new URLSearchParams();
	if (filter) params.append('filter', filter);
	const queryString = params.toString();
	return await makeRestApiRequest<DatabricksGroupsResponse>(
		context,
		'GET',
		`/databricks/groups${queryString ? '?' + queryString : ''}`,
	);
}

/**
 * Get Databricks users for permission assignment
 */
export async function getDatabricksUsers(
	context: IRestApiContext,
	filter?: string,
): Promise<DatabricksUsersResponse> {
	const params = new URLSearchParams();
	if (filter) params.append('filter', filter);
	const queryString = params.toString();
	return await makeRestApiRequest(
		context,
		'GET',
		`/databricks/users${queryString ? '?' + queryString : ''}`,
	);
}

/**
 * Get Databricks service principals for permission assignment
 */
export async function getDatabricksServicePrincipals(
	context: IRestApiContext,
	filter?: string,
): Promise<DatabricksServicePrincipalsResponse> {
	const params = new URLSearchParams();
	if (filter) params.append('filter', filter);
	const queryString = params.toString();
	return await makeRestApiRequest(
		context,
		'GET',
		`/databricks/service-principals${queryString ? '?' + queryString : ''}`,
	);
}

/**
 * Get current user's Databricks info including groups
 */
export async function getDatabricksCurrentUser(
	context: IRestApiContext,
): Promise<DatabricksCurrentUserResponse> {
	return await makeRestApiRequest(context, 'GET', '/databricks/me');
}
