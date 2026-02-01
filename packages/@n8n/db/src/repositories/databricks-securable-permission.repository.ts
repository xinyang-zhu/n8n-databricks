import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { DatabricksSecurablePermission } from '../entities';

@Service()
export class DatabricksSecurablePermissionRepository extends Repository<DatabricksSecurablePermission> {
	constructor(dataSource: DataSource) {
		super(DatabricksSecurablePermission, dataSource.manager);
	}

	/**
	 * Find all permissions for a securable resource
	 */
	async findBySecurable(
		securableType: string,
		securableId: string,
	): Promise<DatabricksSecurablePermission[]> {
		return this.find({
			where: { securableType, securableId },
		});
	}

	/**
	 * Find all scopes for a specific principal on a securable
	 */
	async findBySecurableAndPrincipal(
		securableType: string,
		securableId: string,
		principalType: string,
		principalId: string,
	): Promise<DatabricksSecurablePermission[]> {
		return this.find({
			where: { securableType, securableId, principalType, principalId },
		});
	}

	/**
	 * Find a specific scope for a principal on a securable
	 */
	async findScope(
		securableType: string,
		securableId: string,
		principalType: string,
		principalId: string,
		scope: string,
	): Promise<DatabricksSecurablePermission | null> {
		return this.findOne({
			where: { securableType, securableId, principalType, principalId, permission: scope },
		});
	}

	/**
	 * Find all permissions for a principal (user or group)
	 */
	async findByPrincipal(
		principalType: string,
		principalId: string,
	): Promise<DatabricksSecurablePermission[]> {
		return this.find({
			where: { principalType, principalId },
		});
	}

	/**
	 * Upsert a scope (create if not exists)
	 * Each (securable, principal, scope) tuple is a separate row
	 */
	async upsertPermission(
		securableType: string,
		securableId: string,
		principalType: string,
		principalId: string,
		scope: string,
	): Promise<DatabricksSecurablePermission> {
		const existing = await this.findScope(
			securableType,
			securableId,
			principalType,
			principalId,
			scope,
		);

		if (existing) {
			return existing; // Already exists, nothing to do
		}

		const newPermission = this.create({
			securableType,
			securableId,
			principalType,
			principalId,
			permission: scope,
		});
		return this.save(newPermission);
	}

	/**
	 * Delete a specific scope for a principal on a securable
	 */
	async deletePermission(
		securableType: string,
		securableId: string,
		principalType: string,
		principalId: string,
		scope?: string,
	): Promise<void> {
		const where: Record<string, string> = {
			securableType,
			securableId,
			principalType,
			principalId,
		};
		if (scope) {
			where.permission = scope;
		}
		await this.delete(where);
	}

	/**
	 * Delete all scopes for a principal on a securable
	 */
	async deleteAllForPrincipal(
		securableType: string,
		securableId: string,
		principalType: string,
		principalId: string,
	): Promise<void> {
		await this.delete({ securableType, securableId, principalType, principalId });
	}

	/**
	 * Delete all permissions for a securable
	 */
	async deleteAllForSecurable(securableType: string, securableId: string): Promise<void> {
		await this.delete({ securableType, securableId });
	}
}
