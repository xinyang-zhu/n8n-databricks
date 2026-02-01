import {
	AddDataTableRowsDto,
	AddDataTableColumnDto,
	CreateDataTableDto,
	DeleteDataTableRowsDto,
	ListDataTableContentQueryDto,
	ListDataTableQueryDto,
	MoveDataTableColumnDto,
	RenameDataTableColumnDto,
	UpdateDataTableDto,
	UpdateDataTableRowDto,
	UpsertDataTableRowDto,
} from '@n8n/api-types';
import { GlobalConfig } from '@n8n/config';
import { AuthenticatedRequest } from '@n8n/db';
import {
	Body,
	Delete,
	Get,
	Middleware,
	Param,
	Patch,
	Post,
	ProjectScope,
	Query,
	RestController,
} from '@n8n/decorators';
import { NextFunction, Response } from 'express';
import type { DatabricksPermission } from 'n8n-workflow';
import { DataTableRowReturn } from 'n8n-workflow';

import { ResponseError } from '@/errors/response-errors/abstract/response.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ConflictError } from '@/errors/response-errors/conflict.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';

import { DataTableService } from './data-table.service';
import { DataTableColumnNameConflictError } from './errors/data-table-column-name-conflict.error';
import { DataTableNameConflictError } from './errors/data-table-name-conflict.error';
import { DataTableNotFoundError } from './errors/data-table-not-found.error';
import { DataTableSystemColumnNameConflictError } from './errors/data-table-system-column-name-conflict.error';
import { DataTableValidationError } from './errors/data-table-validation.error';
import { DatabricksPermissionService } from '@/services/databricks-permission.service';
import { ProjectService } from '@/services/project.service.ee';

@RestController('/projects/:projectId/data-tables')
export class DataTableController {
	constructor(
		private readonly dataTableService: DataTableService,
		private readonly projectService: ProjectService,
		private readonly globalConfig: GlobalConfig,
		private readonly databricksPermissionService: DatabricksPermissionService,
	) {}

	/**
	 * Get Databricks token from request (cookie or header)
	 */
	private getDatabricksToken(req: AuthenticatedRequest): string | undefined {
		const cookieToken = req.cookies?.['n8n-databricks-token'];
		if (cookieToken) return cookieToken;
		const headerToken = req.headers['x-databricks-token'] as string | undefined;
		return headerToken;
	}

	/**
	 * Check Databricks permission for a data table.
	 * This should be called AFTER n8n's native access control passes.
	 * Data tables have: READ, WRITE, MANAGE (no USE).
	 */
	private async checkDatabricksPermission(
		req: AuthenticatedRequest,
		dataTableId: string,
		requiredPermission: DatabricksPermission,
	): Promise<void> {
		if (!this.globalConfig.databricks.rbacEnabled) {
			return;
		}

		const databricksToken = this.getDatabricksToken(req);
		const hasPermission = await this.databricksPermissionService.hasPermission(
			'data_table',
			dataTableId,
			req.user,
			requiredPermission,
			databricksToken,
		);

		if (!hasPermission) {
			throw new ForbiddenError(
				`You do not have ${requiredPermission} permission on this data table`,
			);
		}
	}

	private handleDataTableColumnOperationError(e: unknown): never {
		if (
			e instanceof DataTableColumnNameConflictError ||
			e instanceof DataTableSystemColumnNameConflictError ||
			e instanceof DataTableNameConflictError
		) {
			throw new ConflictError(e.message);
		}
		if (e instanceof DataTableValidationError) {
			throw new BadRequestError(e.message);
		}
		if (e instanceof ResponseError) {
			throw e;
		}
		if (e instanceof Error) {
			throw new InternalServerError(e.message, e);
		}
		throw e;
	}

	@Middleware()
	async validateProjectExists(
		req: AuthenticatedRequest<{ projectId: string }>,
		res: Response,
		next: NextFunction,
	) {
		try {
			const { projectId } = req.params;
			await this.projectService.getProject(projectId);
			next();
		} catch (e) {
			res.status(404).send('Project not found');
			return;
		}
	}

	@Post('/')
	@ProjectScope('dataTable:create')
	async createDataTable(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Body dto: CreateDataTableDto,
	) {
		try {
			return await this.dataTableService.createDataTable(req.params.projectId, dto);
		} catch (e: unknown) {
			if (!(e instanceof Error)) {
				throw e;
			} else if (e instanceof DataTableNameConflictError) {
				throw new ConflictError(e.message);
			} else {
				throw new InternalServerError(e.message, e);
			}
		}
	}

	@Get('/')
	@ProjectScope('dataTable:listProject')
	async listProjectDataTables(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Query payload: ListDataTableQueryDto,
	) {
		const providedFilter = payload?.filter ?? {};
		return await this.dataTableService.getManyAndCount({
			...payload,
			filter: { ...providedFilter, projectId: req.params.projectId },
		});
	}

	@Patch('/:dataTableId')
	@ProjectScope('dataTable:update')
	async updateDataTable(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Body dto: UpdateDataTableDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.updateDataTable(dataTableId, req.params.projectId, dto);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof DataTableNameConflictError) {
				throw new ConflictError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Delete('/:dataTableId')
	@ProjectScope('dataTable:delete')
	async deleteDataTable(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'MANAGE');

		try {
			return await this.dataTableService.deleteDataTable(dataTableId, req.params.projectId);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Get('/:dataTableId/columns')
	@ProjectScope('dataTable:read')
	async getColumns(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'READ');

		try {
			return await this.dataTableService.getColumns(dataTableId, req.params.projectId);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Post('/:dataTableId/columns')
	@ProjectScope('dataTable:update')
	async addColumn(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Body dto: AddDataTableColumnDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.addColumn(dataTableId, req.params.projectId, dto);
		} catch (e: unknown) {
			this.handleDataTableColumnOperationError(e);
		}
	}

	@Delete('/:dataTableId/columns/:columnId')
	@ProjectScope('dataTable:update')
	async deleteColumn(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Param('columnId') columnId: string,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.deleteColumn(dataTableId, req.params.projectId, columnId);
		} catch (e: unknown) {
			this.handleDataTableColumnOperationError(e);
		}
	}

	@Patch('/:dataTableId/columns/:columnId/move')
	@ProjectScope('dataTable:update')
	async moveColumn(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Param('columnId') columnId: string,
		@Body dto: MoveDataTableColumnDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.moveColumn(
				dataTableId,
				req.params.projectId,
				columnId,
				dto,
			);
		} catch (e: unknown) {
			this.handleDataTableColumnOperationError(e);
		}
	}

	@Patch('/:dataTableId/columns/:columnId/rename')
	@ProjectScope('dataTable:update')
	async renameColumn(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Param('columnId') columnId: string,
		@Body dto: RenameDataTableColumnDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.renameColumn(
				dataTableId,
				req.params.projectId,
				columnId,
				dto,
			);
		} catch (e: unknown) {
			this.handleDataTableColumnOperationError(e);
		}
	}

	@Get('/:dataTableId/rows')
	@ProjectScope('dataTable:readRow')
	async getDataTableRows(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Query dto: ListDataTableContentQueryDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'READ');

		try {
			return await this.dataTableService.getManyRowsAndCount(
				dataTableId,
				req.params.projectId,
				dto,
			);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Get('/:dataTableId/download-csv')
	@ProjectScope('dataTable:read')
	async downloadDataTableCsv(
		req: AuthenticatedRequest<{ projectId: string; dataTableId: string }>,
		_res: Response,
	) {
		const { projectId, dataTableId } = req.params;

		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'READ');

		try {
			// Generate CSV content - this will validate that the table exists
			const { csvContent, dataTableName } = await this.dataTableService.generateDataTableCsv(
				dataTableId,
				projectId,
			);

			return {
				csvContent,
				dataTableName,
			};
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	/**
	 * @returns the IDs of the inserted rows
	 */
	async appendDataTableRows<T extends DataTableRowReturn | undefined>(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		dataTableId: string,
		dto: AddDataTableRowsDto & { returnType?: T },
	): Promise<Array<T extends true ? DataTableRowReturn : Pick<DataTableRowReturn, 'id'>>>;
	@Post('/:dataTableId/insert')
	@ProjectScope('dataTable:writeRow')
	async appendDataTableRows(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Body dto: AddDataTableRowsDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.insertRows(
				dataTableId,
				req.params.projectId,
				dto.data,
				dto.returnType,
			);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof DataTableValidationError) {
				throw new BadRequestError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Post('/:dataTableId/upsert')
	@ProjectScope('dataTable:writeRow')
	async upsertDataTableRow(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Body dto: UpsertDataTableRowDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			// because of strict overloads, we need separate paths
			const dryRun = dto.dryRun;
			if (dryRun) {
				return await this.dataTableService.upsertRow(
					dataTableId,
					req.params.projectId,
					dto,
					true, // we want to always return data for dry runs
					dryRun,
				);
			}

			const returnData = dto.returnData;
			if (returnData) {
				return await this.dataTableService.upsertRow(
					dataTableId,
					req.params.projectId,
					dto,
					returnData,
					dryRun,
				);
			}

			return await this.dataTableService.upsertRow(
				dataTableId,
				req.params.projectId,
				dto,
				returnData,
				dryRun,
			);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof DataTableValidationError) {
				throw new BadRequestError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Patch('/:dataTableId/rows')
	@ProjectScope('dataTable:writeRow')
	async updateDataTableRows(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Body dto: UpdateDataTableRowDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			// because of strict overloads, we need separate paths
			const dryRun = dto.dryRun;
			if (dryRun) {
				return await this.dataTableService.updateRows(
					dataTableId,
					req.params.projectId,
					dto,
					true, // we want to always return data for dry runs
					dryRun,
				);
			}

			const returnData = dto.returnData;
			if (returnData) {
				return await this.dataTableService.updateRows(
					dataTableId,
					req.params.projectId,
					dto,
					returnData,
					dryRun,
				);
			}

			return await this.dataTableService.updateRows(
				dataTableId,
				req.params.projectId,
				dto,
				returnData,
				dryRun,
			);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof DataTableValidationError) {
				throw new BadRequestError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}

	@Delete('/:dataTableId/rows')
	@ProjectScope('dataTable:writeRow')
	async deleteDataTableRows(
		req: AuthenticatedRequest<{ projectId: string }>,
		_res: Response,
		@Param('dataTableId') dataTableId: string,
		@Query dto: DeleteDataTableRowsDto,
	) {
		// Check Databricks RBAC permission (after n8n access control)
		await this.checkDatabricksPermission(req, dataTableId, 'WRITE');

		try {
			return await this.dataTableService.deleteRows(
				dataTableId,
				req.params.projectId,
				dto,
				dto.returnData,
			);
		} catch (e: unknown) {
			if (e instanceof DataTableNotFoundError) {
				throw new NotFoundError(e.message);
			} else if (e instanceof DataTableValidationError) {
				throw new BadRequestError(e.message);
			} else if (e instanceof Error) {
				throw new InternalServerError(e.message, e);
			} else {
				throw e;
			}
		}
	}
}
