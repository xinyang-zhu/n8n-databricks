<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { N8nButton, N8nIcon, N8nSelect, N8nOption, N8nLoading } from '@n8n/design-system';
import { useToast } from '@/app/composables/useToast';
import { DATABRICKS_PERMISSIONS_MODAL_KEY } from '../constants';
import { createEventBus } from '@n8n/utils/event-bus';
import Modal from './Modal.vue';
import { useRootStore } from '@n8n/stores/useRootStore';
import * as databricksApi from '@n8n/rest-api-client/api/databricks-permissions';
import {
	type DatabricksPermissionGroup,
	type DatabricksSecurableType,
	deepCopy,
} from 'n8n-workflow';

const props = defineProps<{
	modalName: string;
	data: {
		securableType: DatabricksSecurableType;
		securableId: string;
		securableName: string;
	};
}>();

const modalBus = createEventBus();
const toast = useToast();
const rootStore = useRootStore();

const isLoading = ref(true);
const isSaving = ref(false);
const permissionGroups = ref<DatabricksPermissionGroup[]>([]);
const currentUserScopes = ref<string[]>([]);
const availableScopes = ref<string[]>([]);
const canManage = ref(false);

// Local working copy of permission groups for editing
const localPermissionGroups = ref<DatabricksPermissionGroup[]>([]);
// Track if there are unsaved changes
const hasChanges = ref(false);
// Track principals to be removed
const pendingRemovals = ref<Set<string>>(new Set());
// Track new principals to be added
const pendingAdditions = ref<DatabricksPermissionGroup[]>([]);

const newPrincipalValue = ref('');
const newScopes = ref<string[]>([]);

const availableUsers = ref<Array<{ id: string; email: string; displayName: string }>>([]);
const availableGroups = ref<Array<{ id: string; displayName: string }>>([]);
const availableServicePrincipals = ref<
	Array<{ id: string; applicationId: string; displayName: string }>
>([]);

interface PrincipalOption {
	value: string;
	label: string;
	type: 'user' | 'group' | 'servicePrincipal';
	icon: 'user' | 'users' | 'robot';
}

/**
 * Scope descriptions for the dropdown
 */
const scopeDescriptions: Record<string, string> = {
	// Workflow scopes
	'workflow:read': 'View workflow details and configuration',
	'workflow:update': 'Edit workflow nodes and settings',
	'workflow:delete': 'Permanently remove this workflow',
	'workflow:execute': 'Run this workflow manually or via trigger',
	'workflow:share': 'Manage who can access this workflow',
	'workflow:move': 'Move workflow to a different project',
	'workflow:activate': 'Enable workflow triggers',
	'workflow:deactivate': 'Disable workflow triggers',
	'workflow:publish': 'Publish workflow changes',
	// Credential scopes
	'credential:read': 'View credential details',
	'credential:update': 'Edit credential settings',
	'credential:delete': 'Permanently remove this credential',
	'credential:share': 'Manage who can access this credential',
	'credential:move': 'Move credential to a different project',
	// Data table scopes
	'dataTable:read': 'View data table schema and settings',
	'dataTable:update': 'Edit data table schema',
	'dataTable:delete': 'Permanently remove this data table',
	'dataTable:readRow': 'Read rows from this data table',
	'dataTable:writeRow': 'Add, update, or delete rows',
};

/**
 * Get human-readable label for a scope
 */
const getScopeLabel = (scope: string): string => {
	const parts = scope.split(':');
	if (parts.length === 2) {
		const action = parts[1];
		return action.charAt(0).toUpperCase() + action.slice(1);
	}
	return scope;
};

/**
 * Get description for a scope
 */
const getScopeDescription = (scope: string): string => {
	return scopeDescriptions[scope] || '';
};

const scopeOptions = computed(() => {
	return availableScopes.value.map((scope) => ({
		value: scope,
		label: getScopeLabel(scope),
		description: getScopeDescription(scope),
	}));
});

const principalOptions = computed((): PrincipalOption[] => {
	const users = availableUsers.value
		.filter((u) => u.id && (u.displayName || u.email))
		.map((u) => ({
			value: `user:${u.id}`,
			label: `${u.displayName || u.email}`,
			type: 'user' as const,
			icon: 'user' as const,
		}));
	const groups = availableGroups.value
		.filter((g) => g.id && g.displayName)
		.map((g) => ({
			value: `group:${g.id}`,
			label: `${g.displayName}`,
			type: 'group' as const,
			icon: 'users' as const,
		}));
	const servicePrincipals = availableServicePrincipals.value
		.filter((sp) => sp.id && (sp.displayName || sp.applicationId))
		.map((sp) => ({
			value: `servicePrincipal:${sp.id}`,
			label: `${sp.displayName || sp.applicationId} (${sp.applicationId})`,
			type: 'servicePrincipal' as const,
			icon: 'robot' as const,
		}));
	return [...users, ...groups, ...servicePrincipals];
});

// Combined list of groups to display (original + pending additions, minus pending removals)
const displayedGroups = computed(() => {
	const result: DatabricksPermissionGroup[] = [];

	// Add original groups that aren't pending removal
	for (const group of localPermissionGroups.value) {
		const key = `${group.principal.type}:${group.principal.id}`;
		if (!pendingRemovals.value.has(key)) {
			result.push(group);
		}
	}

	// Add pending additions
	result.push(...pendingAdditions.value);

	return result;
});

const initialize = async () => {
	isLoading.value = true;
	try {
		const [permResponse, usersResponse, groupsResponse, servicePrincipalsResponse] =
			await Promise.all([
				databricksApi.getSecurablePermissions(
					rootStore.restApiContext,
					props.data.securableType,
					props.data.securableId,
				),
				databricksApi
					.getDatabricksUsers(rootStore.restApiContext)
					.catch(() => ({ users: [], totalResults: 0 })),
				databricksApi
					.getDatabricksGroups(rootStore.restApiContext)
					.catch(() => ({ groups: [], totalResults: 0 })),
				databricksApi
					.getDatabricksServicePrincipals(rootStore.restApiContext)
					.catch(() => ({ servicePrincipals: [], totalResults: 0 })),
			]);
		permissionGroups.value = permResponse.permissionGroups;
		// Create a deep copy for local editing
		localPermissionGroups.value = deepCopy(permResponse.permissionGroups);
		currentUserScopes.value = permResponse.currentUserScopes;
		availableScopes.value = permResponse.availableScopes;
		canManage.value = permResponse.canManage;
		availableUsers.value = usersResponse.users;
		availableGroups.value = groupsResponse.groups;
		availableServicePrincipals.value = servicePrincipalsResponse.servicePrincipals;

		// Reset change tracking
		hasChanges.value = false;
		pendingRemovals.value = new Set();
		pendingAdditions.value = [];
	} catch (error) {
		toast.showError(error, 'Failed to load permissions');
	} finally {
		isLoading.value = false;
	}
};

const addPermissionLocal = () => {
	if (!newPrincipalValue.value || newScopes.value.length === 0) return;
	const [type, ...idParts] = newPrincipalValue.value.split(':');
	const principalId = idParts.join(':');
	if (!type || !principalId) return;

	const key = `${type}:${principalId}`;

	// Check if this principal already exists in local groups
	const existingLocal = localPermissionGroups.value.find(
		(g) => g.principal.type === type && g.principal.id === principalId,
	);

	// Check if this principal is in pending additions
	const existingPending = pendingAdditions.value.find(
		(g) => g.principal.type === type && g.principal.id === principalId,
	);

	if (existingLocal && !pendingRemovals.value.has(key)) {
		// Principal already exists, merge scopes
		existingLocal.scopes = [...new Set([...existingLocal.scopes, ...newScopes.value])];
	} else if (existingPending) {
		// Principal in pending additions, merge scopes
		existingPending.scopes = [...new Set([...existingPending.scopes, ...newScopes.value])];
	} else if (existingLocal && pendingRemovals.value.has(key)) {
		// Was pending removal, restore with new scopes
		pendingRemovals.value.delete(key);
		existingLocal.scopes = [...newScopes.value];
	} else {
		// New principal
		pendingAdditions.value.push({
			principal: {
				type: type as 'user' | 'group' | 'servicePrincipal',
				id: principalId,
			},
			scopes: [...newScopes.value],
		});
	}

	hasChanges.value = true;
	newPrincipalValue.value = '';
	newScopes.value = [];
};

const removePermissionLocal = (group: DatabricksPermissionGroup) => {
	const key = `${group.principal.type}:${group.principal.id}`;

	// Check if this is a pending addition
	const pendingIndex = pendingAdditions.value.findIndex(
		(g) => g.principal.type === group.principal.type && g.principal.id === group.principal.id,
	);

	if (pendingIndex >= 0) {
		// Remove from pending additions
		pendingAdditions.value.splice(pendingIndex, 1);
	} else {
		// Mark original group for removal
		pendingRemovals.value.add(key);
	}

	hasChanges.value = true;
};

const updateScopesLocal = (group: DatabricksPermissionGroup, scopes: string[]) => {
	// Find if this is an original group or a pending addition
	const originalGroup = localPermissionGroups.value.find(
		(g) => g.principal.type === group.principal.type && g.principal.id === group.principal.id,
	);

	const pendingGroup = pendingAdditions.value.find(
		(g) => g.principal.type === group.principal.type && g.principal.id === group.principal.id,
	);

	if (originalGroup) {
		originalGroup.scopes = scopes;
	} else if (pendingGroup) {
		pendingGroup.scopes = scopes;
	}

	hasChanges.value = true;
};

const saveAllChanges = async () => {
	isSaving.value = true;
	const changes: string[] = [];

	try {
		// Process all removals first
		for (const key of pendingRemovals.value) {
			const [type, ...idParts] = key.split(':');
			const principalId = idParts.join(':');
			const principalName = getPrincipalDisplayName(
				type as 'user' | 'group' | 'servicePrincipal',
				principalId,
			);
			await databricksApi.revokeSecurableScopes(
				rootStore.restApiContext,
				props.data.securableType,
				props.data.securableId,
				type as 'user' | 'group' | 'servicePrincipal',
				principalId,
			);
			changes.push(`Revoked all permissions from ${principalName}`);
		}

		// Process all updates to existing groups
		for (const group of localPermissionGroups.value) {
			const key = `${group.principal.type}:${group.principal.id}`;
			if (pendingRemovals.value.has(key)) continue;

			// Find original to compare
			const original = permissionGroups.value.find(
				(g) => g.principal.type === group.principal.type && g.principal.id === group.principal.id,
			);

			// Check if scopes changed
			const originalScopes = original?.scopes || [];
			const currentScopes = group.scopes;
			const scopesChanged =
				originalScopes.length !== currentScopes.length ||
				!originalScopes.every((s) => currentScopes.includes(s));

			if (scopesChanged) {
				const principalName = getPrincipalDisplayName(group.principal.type, group.principal.id);
				await databricksApi.setSecurableScopes(
					rootStore.restApiContext,
					props.data.securableType,
					props.data.securableId,
					group.principal.type,
					group.principal.id,
					group.scopes,
				);
				changes.push(`Updated ${principalName}: ${group.scopes.join(', ')}`);
			}
		}

		// Process all additions
		for (const group of pendingAdditions.value) {
			const principalName = getPrincipalDisplayName(group.principal.type, group.principal.id);
			await databricksApi.grantSecurableScopes(
				rootStore.restApiContext,
				props.data.securableType,
				props.data.securableId,
				group.principal.type,
				group.principal.id,
				group.scopes,
			);
			changes.push(`Granted to ${principalName}: ${group.scopes.join(', ')}`);
		}

		const changesSummary = changes.length > 0 ? changes.join('\n') : 'No changes made';
		toast.showMessage({
			title: 'Databricks permissions saved',
			message: changesSummary,
			type: 'success',
			duration: 5000,
		});

		// Reload to get fresh state
		await initialize();
	} catch (error) {
		toast.showError(error, 'Failed to save permissions');
	} finally {
		isSaving.value = false;
	}
};

const getPrincipalDisplayName = (
	principalType: 'user' | 'group' | 'servicePrincipal',
	principalId: string,
): string => {
	if (principalType === 'user') {
		const user = availableUsers.value.find((u) => u.id === principalId);
		return user?.displayName || user?.email || principalId;
	} else if (principalType === 'group') {
		const group = availableGroups.value.find((g) => g.id === principalId);
		return group?.displayName || principalId;
	} else {
		const sp = availableServicePrincipals.value.find((s) => s.id === principalId);
		if (sp) {
			return `${sp.displayName || sp.applicationId} (${sp.applicationId})`;
		}
		return principalId;
	}
};

const cancel = () => {
	modalBus.emit('close');
};

const save = async () => {
	if (hasChanges.value) {
		await saveAllChanges();
	}
	modalBus.emit('close');
};

onMounted(async () => {
	await initialize();
});
</script>

<template>
	<Modal
		:name="DATABRICKS_PERMISSIONS_MODAL_KEY"
		width="600px"
		:event-bus="modalBus"
		:show-close="true"
	>
		<template #header>
			<div :class="$style.header">
				<div :class="$style.headerTitle">
					<span :class="$style.headerLabel">Permission Settings for:</span>
					<span :class="$style.headerName">{{ data.securableName }}</span>
				</div>
				<div v-if="currentUserScopes.length > 0" :class="$style.myPermission">
					<span :class="$style.myPermissionLabel">Your scopes:</span>
					<div :class="$style.myPermissionScopes">
						<span v-for="scope in currentUserScopes" :key="scope" :class="$style.scopeBadge">
							{{ getScopeLabel(scope) }}
						</span>
					</div>
				</div>
			</div>
		</template>

		<template #content>
			<div :class="$style.content">
				<N8nLoading v-if="isLoading" :rows="4" />

				<template v-else>
					<!-- Column Headers -->
					<div :class="$style.tableHeader">
						<div :class="$style.nameColumn">NAME</div>
						<div :class="$style.scopesColumn">SCOPES</div>
						<div :class="$style.actionColumn"></div>
					</div>

					<!-- Permission Rows -->
					<div :class="$style.tableBody">
						<!-- Empty state when no permissions -->
						<div v-if="displayedGroups.length === 0 && canManage" :class="$style.emptyStateInline">
							No Databricks permissions granted yet
						</div>

						<div
							v-for="group in displayedGroups"
							:key="`${group.principal.type}-${group.principal.id}`"
							:class="$style.row"
						>
							<div :class="$style.nameColumn">
								<N8nIcon
									:icon="
										group.principal.type === 'user'
											? 'user'
											: group.principal.type === 'group'
												? 'users'
												: 'robot'
									"
									:class="$style.principalIcon"
								/>
								<span :class="$style.principalName">{{
									getPrincipalDisplayName(group.principal.type, group.principal.id)
								}}</span>
							</div>
							<div :class="$style.scopesColumn">
								<N8nSelect
									v-if="canManage"
									:model-value="group.scopes"
									multiple
									size="small"
									:disabled="isSaving"
									:class="$style.scopeSelect"
									@update:model-value="(val) => updateScopesLocal(group, val)"
								>
									<N8nOption
										v-for="opt in scopeOptions"
										:key="opt.value"
										:value="opt.value"
										:label="opt.label"
									>
										<div :class="$style.scopeOptionContent">
											<span :class="$style.scopeOptionLabel">{{ opt.label }}</span>
											<span v-if="opt.description" :class="$style.scopeOptionDescription">{{
												opt.description
											}}</span>
										</div>
									</N8nOption>
								</N8nSelect>
								<div v-else :class="$style.scopeBadges">
									<span v-for="scope in group.scopes" :key="scope" :class="$style.scopeBadge">
										{{ getScopeLabel(scope) }}
									</span>
								</div>
							</div>
							<div :class="$style.actionColumn">
								<button
									v-if="canManage"
									:class="$style.removeBtn"
									:disabled="isSaving"
									@click="removePermissionLocal(group)"
								>
									<N8nIcon icon="trash-2" />
								</button>
							</div>
						</div>

						<!-- Add New Row -->
						<div v-if="canManage" :class="$style.addRow">
							<div :class="$style.nameColumn">
								<N8nSelect
									v-model="newPrincipalValue"
									size="small"
									filterable
									placeholder="Select principal..."
									:class="$style.principalSelect"
								>
									<N8nOption
										v-for="option in principalOptions"
										:key="option.value"
										:value="option.value"
										:label="option.label"
									>
										<div :class="$style.optionContent">
											<N8nIcon :icon="option.icon" :class="$style.optionIcon" />
											<span>{{ option.label }}</span>
										</div>
									</N8nOption>
								</N8nSelect>
							</div>
							<div :class="$style.scopesColumn">
								<N8nSelect
									v-model="newScopes"
									multiple
									size="small"
									placeholder="Select scopes..."
									:disabled="!newPrincipalValue"
									:class="$style.scopeSelect"
								>
									<N8nOption
										v-for="opt in scopeOptions"
										:key="opt.value"
										:value="opt.value"
										:label="opt.label"
									>
										<div :class="$style.scopeOptionContent">
											<span :class="$style.scopeOptionLabel">{{ opt.label }}</span>
											<span v-if="opt.description" :class="$style.scopeOptionDescription">{{
												opt.description
											}}</span>
										</div>
									</N8nOption>
								</N8nSelect>
							</div>
							<div :class="$style.actionColumn">
								<N8nButton
									type="tertiary"
									size="small"
									:disabled="!newPrincipalValue || newScopes.length === 0 || isSaving"
									@click="addPermissionLocal"
								>
									Add
								</N8nButton>
							</div>
						</div>

						<!-- Empty State -->
						<div v-if="displayedGroups.length === 0 && !canManage" :class="$style.emptyState">
							No permissions configured
						</div>
					</div>
				</template>
			</div>
		</template>

		<template #footer>
			<div :class="$style.footer">
				<div :class="$style.footerNote">
					<N8nIcon icon="info-circle" :class="$style.footerNoteIcon" />
					<span>
						Databricks permissions are managed independently from n8n permissions. Users with access
						granted through n8n will retain their permissions regardless of the settings configured
						here, and vice versa.
					</span>
				</div>
				<div :class="$style.footerActions">
					<N8nButton type="secondary" :disabled="isSaving" @click="cancel">Cancel</N8nButton>
					<N8nButton
						type="primary"
						:disabled="isSaving || !hasChanges"
						:loading="isSaving"
						@click="save"
					>
						Save
					</N8nButton>
				</div>
			</div>
		</template>
	</Modal>
</template>

<style module lang="scss">
.header {
	padding: 0;
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
}

.headerTitle {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.headerLabel {
	font-size: var(--font-size--md);
	font-weight: var(--font-weight--regular);
	color: var(--color--text);
}

.headerName {
	font-size: var(--font-size--lg);
	font-weight: var(--font-weight--bold);
	color: var(--color--text--shade-1);
}

.myPermission {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: var(--spacing--4xs);
}

.myPermissionLabel {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.myPermissionScopes {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--4xs);
	justify-content: flex-end;
}

.scopeBadge {
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--bold);
	color: var(--color--success);
	background: var(--color--success--tint-4);
	padding: var(--spacing--5xs) var(--spacing--3xs);
	border-radius: var(--radius--sm);
}

.scopeBadges {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--4xs);
}

.content {
}

.tableHeader {
	display: flex;
	align-items: center;
	padding: var(--spacing--xs) 0;
	border-bottom: 1px solid var(--color--foreground);
	margin-bottom: var(--spacing--sm);
}

.tableHeader .nameColumn,
.tableHeader .scopesColumn {
	font-size: var(--font-size--2xs);
	font-weight: var(--font-weight--bold);
	color: var(--color--text--tint-1);
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.tableBody {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.row {
	display: flex;
	align-items: center;
	padding: var(--spacing--xs) 0;
}

.addRow {
	display: flex;
	align-items: center;
	padding: var(--spacing--md) 0;
	margin-top: var(--spacing--sm);
	border-top: 1px solid var(--color--foreground);
}

.nameColumn {
	width: 180px;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	min-width: 0;
	padding-right: var(--spacing--sm);
}

.scopesColumn {
	flex: 1;
	padding-right: var(--spacing--sm);
}

.actionColumn {
	width: 64px;
	flex-shrink: 0;
	display: flex;
	justify-content: flex-end;
}

.principalIcon {
	color: var(--color--text--tint-1);
	flex-shrink: 0;
}

.principalName {
	font-size: var(--font-size--sm);
	color: var(--color--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.scopeSelect {
	width: 100%;
}

.removeBtn {
	background: none;
	border: none;
	padding: var(--spacing--3xs);
	cursor: pointer;
	color: var(--color--text--tint-1);
	border-radius: var(--radius);
	display: flex;
	align-items: center;
	justify-content: center;

	&:hover {
		color: var(--color--danger);
		background: var(--color--danger--tint-3);
	}

	&:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
}

.principalSelect {
	width: 100%;
}

.optionContent {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.optionIcon {
	color: var(--color--text--tint-1);
}

.scopeOptionContent {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
	padding: var(--spacing--4xs) 0;
}

.scopeOptionLabel {
	font-size: var(--font-size--sm);
	color: var(--color--text);
}

.scopeOptionDescription {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	line-height: var(--line-height--md);
	opacity: 0.7;
}

.emptyState {
	padding: var(--spacing--xl);
	text-align: center;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--sm);
}

.emptyStateInline {
	padding: var(--spacing--sm) 0;
	color: var(--color--text--tint-1);
	font-size: var(--font-size--sm);
}

.footer {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding-top: var(--spacing--md);
	border-top: 1px solid var(--color--foreground);
}

.footerNote {
	display: flex;
	align-items: flex-start;
	gap: var(--spacing--xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	line-height: var(--line-height--xl);
}

.footerNoteIcon {
	flex-shrink: 0;
	margin-top: 2px;
}

.footerActions {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--sm);
}
</style>
