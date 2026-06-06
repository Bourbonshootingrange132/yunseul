import type { YunseulSettings } from '../settings';
import type { LMClient } from './client';

// Health-check wrapper. Translates LMClient.probe's machine-shaped
// result into a user-facing message + a connection-state enum we
// expose on the plugin. The actionable strings live here, not in the
// UI, so different surfaces (banner, Notice, test-button result) can
// share the same wording without duplicating phrasing.

/**
 * Connection state envelope. The string-only `kind` plus
 * provider-aware `message` ride alongside the discrete `state`
 * field so call sites that only need ready/offline/unknown (CSS
 * classes, status-dot color) continue to read `.state` while
 * callers that need to render a user-facing banner detail can
 * read `.message`. `kind` is the provider's own discriminator
 * (e.g. `cors-blocked`, `not-found`, `not-logged-in`); used by
 * the banner to pick its actionable copy.
 */
export type ConnectionStatusValue = 'unknown' | 'ready' | 'offline';

export interface ConnectionState {
	state: ConnectionStatusValue;
	/**
	 * Provider-aware actionable message. Undefined for the initial
	 * 'unknown' state and for the bare ready state; populated when
	 * the probe surfaces a kind-specific explanation worth showing
	 * in the banner.
	 */
	message?: string;
	/**
	 * Provider-specific discriminator. Known values include
	 * LM Studio: `ok`, `offline`, `cors-blocked`, `http-error`;
	 * Claude Code: `ok`, `not-found`, `not-logged-in`, `spawn-error`,
	 * `exit-error`. Open set per provider.
	 */
	kind?: string;
}

export interface HealthResult {
	state: ConnectionStatusValue;
	message: string;
	corsBlocked: boolean;
}

export async function runHealthCheck(
	client: LMClient,
	getSettings: () => YunseulSettings,
): Promise<HealthResult> {
	const baseUrl = getSettings().lmStudio.baseUrl;
	const result = await client.probeDetailed();
	if (result.ok) {
		return {
			state: 'ready',
			message: `Connected to ${baseUrl}.`,
			corsBlocked: false,
		};
	}
	if (result.corsBlocked) {
		return {
			state: 'offline',
			message: `Server is reachable but blocks browser requests. Enable CORS in LM Studio (lms server start --cors).`,
			corsBlocked: true,
		};
	}
	if (typeof result.status === 'number') {
		return {
			state: 'offline',
			message: `Server returned HTTP ${result.status} at ${baseUrl}.`,
			corsBlocked: false,
		};
	}
	return {
		state: 'offline',
		message: `Server unreachable at ${baseUrl}.`,
		corsBlocked: false,
	};
}
