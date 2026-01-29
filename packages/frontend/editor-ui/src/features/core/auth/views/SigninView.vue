<script setup lang="ts">
import { computed, reactive, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AuthView from './AuthView.vue';
import MfaView from './MfaView.vue';

import { useToast } from '@/app/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { useTelemetry } from '@/app/composables/useTelemetry';

import { useUsersStore } from '@/features/settings/users/users.store';
import { useSettingsStore } from '@/app/stores/settings.store';
import { useSSOStore } from '@/features/settings/sso/sso.store';
import { useRootStore } from '@n8n/stores/useRootStore';

import type { IFormBoxConfig } from '@/Interface';
import { MFA_AUTHENTICATION_REQUIRED_ERROR_CODE, VIEWS, MFA_FORM } from '@/app/constants';
import type { LoginRequestDto } from '@n8n/api-types';
import { makeRestApiRequest } from '@n8n/rest-api-client';

export type EmailOrLdapLoginIdAndPassword = Pick<
	LoginRequestDto,
	'emailOrLdapLoginId' | 'password'
>;

export type MfaCodeOrMfaRecoveryCode = Pick<LoginRequestDto, 'mfaCode' | 'mfaRecoveryCode'>;

const usersStore = useUsersStore();
const settingsStore = useSettingsStore();
const ssoStore = useSSOStore();
const rootStore = useRootStore();

const route = useRoute();
const router = useRouter();

const toast = useToast();
const locale = useI18n();
const telemetry = useTelemetry();

const loading = ref(false);
const showMfaView = ref(false);
const emailOrLdapLoginId = ref('');
const password = ref('');
const reportError = ref(false);
const loginMode = ref<'none' | 'token' | 'password'>('none');

const ldapLoginLabel = computed(() => ssoStore.ldapLoginLabel);
const isLdapLoginEnabled = computed(() => ssoStore.isLdapLoginEnabled);
const emailLabel = computed(() => {
	let label = locale.baseText('auth.email');
	if (isLdapLoginEnabled.value && ldapLoginLabel.value) {
		label = ldapLoginLabel.value;
	}
	return label;
});

const formConfig = computed<IFormBoxConfig>(() => {
	if (loginMode.value === 'token') {
		return {
			title: locale.baseText('auth.signin'),
			buttonText: locale.baseText('auth.signin'),
			inputs: [
				{
					name: 'databricksToken',
					properties: {
						label: 'Databricks Personal Access Token',
						type: 'password',
						required: true,
						showRequiredAsterisk: false,
						validateOnBlur: false,
						autocomplete: 'off',
						capitalize: true,
						focusInitially: true,
					},
				},
			],
		};
	}
	if (loginMode.value === 'password') {
		return {
			title: locale.baseText('auth.signin'),
			buttonText: locale.baseText('auth.signin'),
			redirectText: locale.baseText('forgotPassword'),
			redirectLink: '/forgot-password',
			inputs: [
				{
					name: 'emailOrLdapLoginId',
					properties: {
						label: emailLabel.value,
						type: 'email',
						required: true,
						...(!isLdapLoginEnabled.value && { validationRules: [{ name: 'VALID_EMAIL' }] }),
						showRequiredAsterisk: false,
						validateOnBlur: false,
						autocomplete: 'email',
						capitalize: true,
						focusInitially: true,
					},
				},
				{
					name: 'password',
					properties: {
						label: locale.baseText('auth.password'),
						type: 'password',
						required: true,
						showRequiredAsterisk: false,
						validateOnBlur: false,
						autocomplete: 'current-password',
						capitalize: true,
					},
				},
			],
		};
	}
	// Default 'none' mode - federated login only
	return {
		title: locale.baseText('auth.signin'),
		buttonText: '',
		inputs: [],
	};
});

const onMFASubmitted = async (form: MfaCodeOrMfaRecoveryCode) => {
	await login({
		emailOrLdapLoginId: emailOrLdapLoginId.value,
		password: password.value,
		mfaCode: form.mfaCode,
		mfaRecoveryCode: form.mfaRecoveryCode,
	});
};

const onEmailPasswordSubmitted = async (form: EmailOrLdapLoginIdAndPassword) => {
	await login(form);
};

const isRedirectSafe = () => {
	const redirect = getRedirectQueryParameter();

	// Allow local redirects
	if (redirect.startsWith('/')) {
		return true;
	}

	try {
		// Only allow origin domain redirects
		const url = new URL(redirect);
		return url.origin === window.location.origin;
	} catch {
		return false;
	}
};

const getRedirectQueryParameter = () => {
	let redirect = '';
	if (typeof route.query?.redirect === 'string') {
		redirect = decodeURIComponent(route.query?.redirect);
	}
	return redirect;
};

const login = async (form: LoginRequestDto) => {
	try {
		loading.value = true;
		await usersStore.loginWithCreds({
			emailOrLdapLoginId: form.emailOrLdapLoginId,
			password: form.password,
			mfaCode: form.mfaCode,
			mfaRecoveryCode: form.mfaRecoveryCode,
			databricksToken: form.databricksToken,
		});
		loading.value = false;
		await settingsStore.getSettings();

		toast.clearAllStickyNotifications();

		if (settingsStore.isMFAEnforced && !usersStore.currentUser?.mfaAuthenticated) {
			await router.push({ name: VIEWS.PERSONAL_SETTINGS });
			return;
		}

		telemetry.track('User attempted to login', {
			result: showMfaView.value ? 'mfa_success' : 'success',
		});

		if (isRedirectSafe()) {
			const redirect = getRedirectQueryParameter();
			if (redirect.startsWith('http')) {
				window.location.href = redirect;
				return;
			}

			void router.push(redirect);
			return;
		}

		await router.push({ name: VIEWS.HOMEPAGE });
	} catch (error) {
		if (error.errorCode === MFA_AUTHENTICATION_REQUIRED_ERROR_CODE) {
			showMfaView.value = true;
			cacheCredentials(form);
			return;
		}

		telemetry.track('User attempted to login', {
			result: showMfaView.value ? 'mfa_token_rejected' : 'credentials_error',
		});

		if (!showMfaView.value) {
			toast.showError(error, locale.baseText('auth.signin.error'));
			loading.value = false;
			return;
		}

		reportError.value = true;
	}
};

const onBackClick = (fromForm: string) => {
	reportError.value = false;
	if (fromForm === MFA_FORM.MFA_TOKEN) {
		showMfaView.value = false;
		loading.value = false;
	}
};
const onFormChanged = (toForm: string) => {
	if (toForm === MFA_FORM.MFA_RECOVERY_CODE) {
		reportError.value = false;
	}
};
const cacheCredentials = (form: EmailOrLdapLoginIdAndPassword) => {
	emailOrLdapLoginId.value = form.emailOrLdapLoginId;
	password.value = form.password;
};

const onFederatedLogin = async () => {
	try {
		loading.value = true;
		const user = await makeRestApiRequest(rootStore.restApiContext, 'POST', '/login/databricks-federated');
		usersStore.setCurrentUser(user);
		await settingsStore.getSettings();
		toast.clearAllStickyNotifications();

		telemetry.track('User attempted to login', {
			result: 'federated_success',
		});

		if (isRedirectSafe()) {
			const redirect = getRedirectQueryParameter();
			if (redirect.startsWith('http')) {
				window.location.href = redirect;
				return;
			}
			void router.push(redirect);
			return;
		}

		await router.push({ name: VIEWS.HOMEPAGE });
	} catch (error) {
		toast.showError(error, 'Federated login failed');
		loading.value = false;
	}
};

const onTokenSubmitted = async (form: { databricksToken: string }) => {
	await login({ databricksToken: form.databricksToken });
};

onMounted(async () => {
	// Auto-login via query parameter
	const databricksToken = route.query.databricksToken as string | undefined;
	if (databricksToken) {
		await login({ databricksToken });
	}
});
</script>

<template>
	<div>
		<AuthView
			v-if="!showMfaView"
			:form="formConfig"
			:form-loading="loading"
			:with-sso="loginMode === 'password'"
			data-test-id="signin-form"
			@submit="loginMode === 'token' ? onTokenSubmitted($event) : onEmailPasswordSubmitted($event)"
		>
			<template #sso>
				<div v-if="loginMode === 'none'" :style="{ textAlign: 'center' }">
					<n8n-button
						:label="'Sign in with Databricks'"
						:loading="loading"
						size="large"
						@click="onFederatedLogin"
					/>
					<div :style="{ marginTop: '16px' }">
						<a href="#" @click.prevent="loginMode = 'token'">Sign in with token</a>
						<span :style="{ margin: '0 8px' }">|</span>
						<a href="#" @click.prevent="loginMode = 'password'">Sign in with password</a>
					</div>
				</div>
				<div v-else-if="loginMode === 'token'" :style="{ textAlign: 'center', marginTop: '16px' }">
					<a href="#" @click.prevent="loginMode = 'none'">Back to federated login</a>
					<span :style="{ margin: '0 8px' }">|</span>
					<a href="#" @click.prevent="loginMode = 'password'">Sign in with password</a>
				</div>
				<div v-else :style="{ textAlign: 'center', marginTop: '16px' }">
					<a href="#" @click.prevent="loginMode = 'none'">Back to federated login</a>
					<span :style="{ margin: '0 8px' }">|</span>
					<a href="#" @click.prevent="loginMode = 'token'">Sign in with token</a>
				</div>
			</template>
		</AuthView>
		<MfaView
			v-if="showMfaView"
			:report-error="reportError"
			@submit="onMFASubmitted"
			@on-back-click="onBackClick"
			@on-form-changed="onFormChanged"
		/>
	</div>
</template>
