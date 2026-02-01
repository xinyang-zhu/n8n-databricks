import type { MigrationContext, ReversibleMigration } from '../migration-types';

const tableName = 'databricks_securable_permission';

/**
 * Updates the databricks_securable_permission table to:
 * 1. Drop the old unique constraint (without permission column)
 * 2. Add new unique constraint including the permission/scope column
 * 3. Increase column sizes for longer scope names and servicePrincipal type
 *
 * This allows multiple scope rows per principal (granular permissions).
 */
export class UpdateDatabricksPermissionUniqueConstraint1770000000001
	implements ReversibleMigration
{
	async up({ schemaBuilder: { createIndex }, runQuery }: MigrationContext) {
		// Drop the old unique constraint (try multiple naming patterns)
		// PostgreSQL creates constraint names like: tablename_col1_col2_key
		const constraintPatterns = [
			`${tableName}_securableType_securableId_principalType_principalId_key`,
			`UQ_${tableName}_securableType_securableId_principalType_principalId`,
			`IDX_${tableName}_securableType_securableId_principalType_principalId`,
		];

		for (const constraint of constraintPatterns) {
			try {
				await runQuery(`ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
			} catch {
				// Constraint doesn't exist with this name, try next
			}
			try {
				await runQuery(`DROP INDEX IF EXISTS "${constraint}"`);
			} catch {
				// Index doesn't exist with this name, try next
			}
		}

		// Alter column sizes for longer values
		await runQuery(`ALTER TABLE "${tableName}" ALTER COLUMN "principalType" TYPE VARCHAR(20)`);
		await runQuery(`ALTER TABLE "${tableName}" ALTER COLUMN "permission" TYPE VARCHAR(32)`);

		// Create new unique index including permission column
		await createIndex(
			tableName,
			['securableType', 'securableId', 'principalType', 'principalId', 'permission'],
			true,
		);
	}

	async down({ schemaBuilder: { createIndex }, runQuery }: MigrationContext) {
		// Drop the new unique constraint
		const newConstraint = `IDX_${tableName}_securableType_securableId_principalType_principalId_permission`;
		try {
			await runQuery(`ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${newConstraint}"`);
		} catch {
			// Try as index
		}
		try {
			await runQuery(`DROP INDEX IF EXISTS "${newConstraint}"`);
		} catch {
			// Already dropped
		}

		// Revert column sizes
		await runQuery(`ALTER TABLE "${tableName}" ALTER COLUMN "principalType" TYPE VARCHAR(16)`);
		await runQuery(`ALTER TABLE "${tableName}" ALTER COLUMN "permission" TYPE VARCHAR(16)`);

		// Recreate the old unique index (without permission)
		await createIndex(
			tableName,
			['securableType', 'securableId', 'principalType', 'principalId'],
			true,
		);
	}
}
