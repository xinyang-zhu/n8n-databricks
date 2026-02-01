import { LoginRequestDto, ResolveSignupTokenQueryDto } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Time } from '@n8n/constants';
import type { User, PublicUser } from '@n8n/db';
import { UserRepository, AuthenticatedRequest, GLOBAL_OWNER_ROLE } from '@n8n/db';
import {
	Body,
	createBodyKeyedRateLimiter,
	Get,
	Post,
	Query,
	RestController,
} from '@n8n/decorators';
import { Container } from '@n8n/di';
import { isEmail } from 'class-validator';
import { Response } from 'express';

import { handleEmailLogin } from '@/auth';
import { AuthService } from '@/auth/auth.service';
import { DatabricksPermissionService } from '@/services/databricks-permission.service';
import { PasswordUtility } from '@/services/password.utility';
import { RESPONSE_ERROR_MESSAGES } from '@/constants';
import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { EventService } from '@/events/event.service';
import { License } from '@/license';
import { MfaService } from '@/mfa/mfa.service';
import { PostHogClient } from '@/posthog';
import { AuthlessRequest } from '@/requests';
import { UserService } from '@/services/user.service';
import {
	getCurrentAuthenticationMethod,
	isLdapCurrentAuthenticationMethod,
	isOidcCurrentAuthenticationMethod,
	isSamlCurrentAuthenticationMethod,
	isSsoCurrentAuthenticationMethod,
} from '@/sso.ee/sso-helpers';

@RestController()
export class AuthController {
	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly authService: AuthService,
		private readonly mfaService: MfaService,
		private readonly userService: UserService,
		private readonly license: License,
		private readonly userRepository: UserRepository,
		private readonly eventService: EventService,
		private readonly passwordUtility: PasswordUtility,
		private readonly databricksPermissionService: DatabricksPermissionService,
		private readonly postHog?: PostHogClient,
	) {}

	/** Log in a user */
	@Post('/login', {
		skipAuth: true,
		// Two layered rate limit to ensure multiple users can login from the same
		// IP address but aggressive per email limit.
		ipRateLimit: {
			limit: 1000,
			windowMs: 5 * Time.minutes.toMilliseconds,
		},
		keyedRateLimit: createBodyKeyedRateLimiter<LoginRequestDto>({
			limit: 5,
			windowMs: 1 * Time.minutes.toMilliseconds,
			field: 'emailOrLdapLoginId',
		}),
	})
	async login(
		req: AuthlessRequest,
		res: Response,
		@Body payload: LoginRequestDto,
	): Promise<PublicUser | undefined> {
		const {
			emailOrLdapLoginId = '',
			password = '',
			mfaCode,
			mfaRecoveryCode,
			databricksToken,
		} = payload;

		let user: User | undefined;

		let usedAuthenticationMethod = getCurrentAuthenticationMethod();

		// Databricks token-based login
		if (databricksToken) {
			if (!this.globalConfig.databricks.tokenLoginEnabled) {
				throw new AuthError('Databricks token login is not enabled');
			}

			try {
				const databricksResponse = await fetch(this.databricksPermissionService.getScimUrl('Me'), {
					headers: {
						Authorization: `Bearer ${databricksToken}`,
					},
				});

				if (!databricksResponse.ok) {
					throw new AuthError('Invalid Databricks token');
				}

				const databricksUser = (await databricksResponse.json()) as {
					emails?: Array<{ value: string; primary?: boolean }>;
					displayName?: string;
					userName?: string;
					id?: string;
				};
				let primaryEmail = databricksUser.emails?.find((e) => e.primary)?.value;

				// Handle service principals which have UUIDs instead of real emails
				if (!primaryEmail || !primaryEmail.includes('@')) {
					// For service principals, construct an email-like identifier
					if (databricksUser.displayName && databricksUser.id) {
						primaryEmail = `sp-${databricksUser.id}@databricks.local`;
					} else {
						throw new AuthError('Could not retrieve email from Databricks profile');
					}
				}

				user =
					(await this.userRepository.findOne({
						where: { email: primaryEmail },
						relations: ['role'],
					})) ?? undefined;

				if (!user) {
					// Auto-provision user with personal project
					const randomPassword = await this.passwordUtility.hash(
						Math.random().toString(36).slice(-16),
					);
					const result = await this.userRepository.createUserWithProject({
						email: primaryEmail,
						firstName: databricksUser.displayName?.split(' ')[0] ?? '',
						lastName: databricksUser.displayName?.split(' ').slice(1).join(' ') ?? '',
						password: randomPassword,
						role: { slug: 'global:member' },
					});
					user = result.user;
				}

				this.authService.issueCookie(res, user, false, req.browserId);

				// Store Databricks token server-side for SCIM API calls
				this.databricksPermissionService.setUserToken(user.id, databricksToken);

				this.eventService.emit('user-logged-in', {
					user,
					authenticationMethod: 'databricks',
				});

				return await this.userService.toPublic(user, {
					posthog: this.postHog,
					withScopes: true,
					mfaAuthenticated: false,
				});
			} catch (error) {
				this.logger.error('Databricks token login failed', { error });
				throw new AuthError('Databricks authentication failed');
			}
		}

		if (
			usedAuthenticationMethod === 'email' &&
			emailOrLdapLoginId &&
			!isEmail(emailOrLdapLoginId)
		) {
			throw new BadRequestError('Invalid email address');
		}

		// Check if email login is enabled (skip check for SSO methods which have their own controls)
		if (usedAuthenticationMethod === 'email' && !this.globalConfig.authMethods.emailEnabled) {
			throw new AuthError('Email/password login is not enabled');
		}

		if (isSamlCurrentAuthenticationMethod() || isOidcCurrentAuthenticationMethod()) {
			// attempt to fetch user data with the credentials, but don't log in yet
			const preliminaryUser = await handleEmailLogin(emailOrLdapLoginId, password);
			// if the user is an owner, continue with the login
			if (
				preliminaryUser?.role.slug === GLOBAL_OWNER_ROLE.slug ||
				preliminaryUser?.settings?.allowSSOManualLogin
			) {
				user = preliminaryUser;
				usedAuthenticationMethod = 'email';
			} else {
				throw new AuthError('SSO is enabled, please log in with SSO');
			}
		} else if (isLdapCurrentAuthenticationMethod()) {
			const preliminaryUser = await handleEmailLogin(emailOrLdapLoginId, password);
			if (preliminaryUser?.role.slug === GLOBAL_OWNER_ROLE.slug) {
				user = preliminaryUser;
				usedAuthenticationMethod = 'email';
			} else {
				const { LdapService } = await import('@/modules/ldap.ee/ldap.service.ee');
				user = await Container.get(LdapService).handleLdapLogin(emailOrLdapLoginId, password);
			}
		} else {
			user = await handleEmailLogin(emailOrLdapLoginId, password);
		}

		if (user) {
			if (user.mfaEnabled) {
				if (!mfaCode && !mfaRecoveryCode) {
					throw new AuthError('MFA Error', 998);
				}

				const isMfaCodeOrMfaRecoveryCodeValid = await this.mfaService.validateMfa(
					user.id,
					mfaCode,
					mfaRecoveryCode,
				);
				if (!isMfaCodeOrMfaRecoveryCodeValid) {
					throw new AuthError('Invalid mfa token or recovery code');
				}
			}

			// If user.mfaEnabled is enabled we checked for the MFA code, therefore it was used during this login execution
			this.authService.issueCookie(res, user, user.mfaEnabled, req.browserId);

			this.eventService.emit('user-logged-in', {
				user,
				authenticationMethod: usedAuthenticationMethod,
			});

			return await this.userService.toPublic(user, {
				posthog: this.postHog,
				withScopes: true,
				mfaAuthenticated: user.mfaEnabled,
			});
		}
		this.eventService.emit('user-login-failed', {
			authenticationMethod: usedAuthenticationMethod,
			userEmail: emailOrLdapLoginId || 'unknown',
			reason: 'wrong credentials',
		});
		throw new AuthError('Wrong username or password. Do you have caps lock on?');
	}

	/** Databricks federated login via reverse proxy */
	@Post('/login/databricks-federated', { skipAuth: true, ipRateLimit: true })
	async federatedLogin(req: AuthlessRequest, res: Response): Promise<PublicUser> {
		if (!this.globalConfig.databricks.federatedLoginEnabled) {
			throw new AuthError('Databricks federated login is not enabled');
		}

		const token = req.headers['x-forwarded-access-token'] as string | undefined;

		if (!token) {
			throw new AuthError('Missing access token');
		}

		try {
			const databricksResponse = await fetch(this.databricksPermissionService.getScimUrl('Me'), {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!databricksResponse.ok) {
				throw new AuthError('Invalid Databricks token');
			}

			const databricksUser = (await databricksResponse.json()) as {
				emails?: Array<{ value: string; primary?: boolean }>;
				displayName?: string;
				userName?: string;
				id?: string;
			};
			let primaryEmail = databricksUser.emails?.find((e) => e.primary)?.value;

			// Handle service principals which have UUIDs instead of real emails
			if (!primaryEmail || !primaryEmail.includes('@')) {
				// For service principals, construct an email-like identifier
				if (databricksUser.displayName && databricksUser.id) {
					primaryEmail = `sp-${databricksUser.id}@databricks.local`;
				} else {
					throw new AuthError('Could not retrieve email from Databricks profile');
				}
			}

			let user =
				(await this.userRepository.findOne({
					where: { email: primaryEmail },
					relations: ['role'],
				})) ?? undefined;

			if (!user) {
				// Auto-provision user with personal project
				const randomPassword = await this.passwordUtility.hash(
					Math.random().toString(36).slice(-16),
				);
				const result = await this.userRepository.createUserWithProject({
					email: primaryEmail,
					firstName: databricksUser.displayName?.split(' ')[0] ?? '',
					lastName: databricksUser.displayName?.split(' ').slice(1).join(' ') ?? '',
					password: randomPassword,
					role: { slug: 'global:member' },
				});
				user = result.user;
			}

			this.authService.issueCookie(res, user, false, req.browserId);

			// Store Databricks token server-side for SCIM API calls
			this.logger.debug('[DBX-TOKEN] Federated login - storing token', {
				userId: user.id,
				tokenLength: token.length,
				tokenPrefix: token.substring(0, 10) + '...',
			});
			this.databricksPermissionService.setUserToken(user.id, token);

			this.eventService.emit('user-logged-in', {
				user,
				authenticationMethod: 'databricks',
			});

			this.logger.debug('[DBX-TOKEN] Federated login complete', {
				userId: user.id,
				userEmail: primaryEmail,
			});

			return await this.userService.toPublic(user, {
				posthog: this.postHog,
				withScopes: true,
				mfaAuthenticated: false,
			});
		} catch (error) {
			this.logger.error('Databricks federated login failed', { error });
			throw new AuthError('Databricks authentication failed');
		}
	}

	/** Check if the user is already logged in */
	@Get('/login', {
		allowSkipMFA: true,
	})
	async currentUser(req: AuthenticatedRequest): Promise<PublicUser> {
		// We need auth identities to determine signInType in toPublic method
		const user = await this.userService.findUserWithAuthIdentities(req.user.id);

		return await this.userService.toPublic(user, {
			posthog: this.postHog,
			withScopes: true,
			mfaAuthenticated: req.authInfo?.usedMfa,
		});
	}

	/** Validate invite token to enable invitee to set up their account */
	@Get('/resolve-signup-token', { skipAuth: true })
	async resolveSignupToken(
		_req: AuthlessRequest,
		_res: Response,
		@Query payload: ResolveSignupTokenQueryDto,
	) {
		if (isSsoCurrentAuthenticationMethod()) {
			this.logger.debug(
				'Invite links are not supported on this system, please use single sign on instead.',
			);
			throw new BadRequestError(
				'Invite links are not supported on this system, please use single sign on instead.',
			);
		}

		const { inviterId, inviteeId } = await this.userService.getInvitationIdsFromPayload(payload);

		const isWithinUsersLimit = this.license.isWithinUsersLimit();

		if (!isWithinUsersLimit) {
			this.logger.debug('Request to resolve signup token failed because of users quota reached', {
				inviterId,
				inviteeId,
			});
			throw new ForbiddenError(RESPONSE_ERROR_MESSAGES.USERS_QUOTA_REACHED);
		}

		const users = await this.userRepository.findManyByIds([inviterId, inviteeId], {
			includeRole: true,
		});

		if (users.length !== 2) {
			this.logger.debug(
				'Request to resolve signup token failed because the ID of the inviter and/or the ID of the invitee were not found in database',
				{ inviterId, inviteeId },
			);
			throw new BadRequestError('Invalid invite URL');
		}

		const invitee = users.find((user) => user.id === inviteeId);
		if (!invitee || invitee.password) {
			this.logger.error('Invalid invite URL - invitee already setup', {
				inviterId,
				inviteeId,
			});
			throw new BadRequestError('The invitation was likely either deleted or already claimed');
		}

		const inviter = users.find((user) => user.id === inviterId);
		if (!inviter?.email || !inviter?.firstName) {
			this.logger.error(
				'Request to resolve signup token failed because inviter does not exist or is not set up',
				{
					inviterId: inviter?.id,
				},
			);
			throw new BadRequestError('Invalid request');
		}

		this.eventService.emit('user-invite-email-click', { inviter, invitee });

		const { firstName, lastName } = inviter;
		return { inviter: { firstName, lastName } };
	}

	/** Log out a user */
	@Post('/logout')
	async logout(req: AuthenticatedRequest, res: Response) {
		await this.authService.invalidateToken(req);
		this.authService.clearCookie(res);
		return { loggedOut: true };
	}
}
