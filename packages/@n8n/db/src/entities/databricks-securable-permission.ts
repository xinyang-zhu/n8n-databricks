import { Column, Entity, Index, Unique } from '@n8n/typeorm';

import { WithTimestampsAndStringId } from './abstract-entity';

/**
 * Stores Databricks RBAC permissions for securable resources (workflows, credentials, data tables).
 * Each row represents a single scope grant from a principal (user/group) to a securable resource.
 * Multiple rows per principal allow for granular scope control.
 */
@Entity({ name: 'databricks_securable_permission' })
@Unique(['securableType', 'securableId', 'principalType', 'principalId', 'permission'])
@Index(['securableType', 'securableId'])
@Index(['principalType', 'principalId'])
export class DatabricksSecurablePermission extends WithTimestampsAndStringId {
	/**
	 * Type of the securable resource: 'workflow', 'credential', or 'data_table'
	 */
	@Column({ length: 32 })
	securableType: string;

	/**
	 * ID of the securable resource (workflow ID, credential ID, etc.)
	 */
	@Column({ length: 36 })
	@Index()
	securableId: string;

	/**
	 * Type of principal: 'user', 'group', or 'servicePrincipal'
	 */
	@Column({ length: 20 })
	principalType: string;

	/**
	 * ID of the principal (Databricks SCIM user ID or group ID)
	 */
	@Column({ length: 255 })
	principalId: string;

	/**
	 * Scope/permission: n8n scope like 'workflow:read', 'workflow:execute', etc.
	 */
	@Column({ length: 32 })
	permission: string;
}
