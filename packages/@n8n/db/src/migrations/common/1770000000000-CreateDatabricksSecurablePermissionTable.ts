import type { MigrationContext, ReversibleMigration } from '../migration-types';

const tableName = 'databricks_securable_permission';

/**
 * Creates the databricks_securable_permission table for storing Databricks RBAC permissions
 * on securable resources (workflows, credentials, data tables).
 * Each row represents a single scope grant (multiple rows per principal for granular control).
 */
export class CreateDatabricksSecurablePermissionTable1770000000000 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, column, createIndex } }: MigrationContext) {
		await createTable(tableName).withColumns(
			column('id').varchar(36).primary.notNull,
			column('securableType').varchar(32).notNull,
			column('securableId').varchar(36).notNull,
			column('principalType').varchar(20).notNull, // 'user', 'group', 'servicePrincipal'
			column('principalId').varchar(255).notNull,
			column('permission').varchar(32).notNull, // n8n scopes like 'workflow:read'
		).withTimestamps;

		// Index for looking up permissions by securable
		await createIndex(tableName, ['securableType', 'securableId']);

		// Index for looking up permissions by principal
		await createIndex(tableName, ['principalType', 'principalId']);

		// Index for just securableId (common lookup pattern)
		await createIndex(tableName, ['securableId']);

		// Unique constraint: one row per scope per principal per securable
		await createIndex(
			tableName,
			['securableType', 'securableId', 'principalType', 'principalId', 'permission'],
			true,
		);
	}

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(tableName);
	}
}
