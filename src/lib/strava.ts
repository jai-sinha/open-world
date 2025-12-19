// Strava API client for authentication and activity fetching
// Handles OAuth flow and paginated activity retrieval

import type { StravaActivity, StravaTokenResponse } from "../types";

const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const STRAVA_AUTH_BASE = "https://www.strava.com/oauth";

export interface StravaConfig {
	clientId: string;
	redirectUri: string;
	useLocalServer: boolean; // true if using local OAuth exchange server
}

/**
 * Store and retrieve tokens from localStorage
 */
class TokenStore {
	private static readonly TOKEN_KEY = "strava_access_token";
	private static readonly REFRESH_KEY = "strava_refresh_token";
	private static readonly EXPIRES_KEY = "strava_expires_at";
	private static readonly ATHLETE_KEY = "strava_athlete";

	static save(tokenResponse: StravaTokenResponse): void {
		localStorage.setItem(this.TOKEN_KEY, tokenResponse.access_token);
		localStorage.setItem(this.REFRESH_KEY, tokenResponse.refresh_token);
		localStorage.setItem(this.EXPIRES_KEY, tokenResponse.expires_at.toString());
		if (tokenResponse.athlete) {
			localStorage.setItem(this.ATHLETE_KEY, JSON.stringify(tokenResponse.athlete));
		}
	}

	static load(): StravaTokenResponse | null {
		const accessToken = localStorage.getItem(this.TOKEN_KEY);
		const refreshToken = localStorage.getItem(this.REFRESH_KEY);
		const expiresAt = localStorage.getItem(this.EXPIRES_KEY);

		if (!accessToken || !refreshToken || !expiresAt) {
			return null;
		}

		const athleteStr = localStorage.getItem(this.ATHLETE_KEY);
		const athlete = athleteStr ? JSON.parse(athleteStr) : undefined;

		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_at: parseInt(expiresAt, 10),
			athlete,
		};
	}

	static clear(): void {
		localStorage.removeItem(this.TOKEN_KEY);
		localStorage.removeItem(this.REFRESH_KEY);
		localStorage.removeItem(this.EXPIRES_KEY);
		localStorage.removeItem(this.ATHLETE_KEY);
	}

	static isExpired(): boolean {
		const expiresAt = localStorage.getItem(this.EXPIRES_KEY);
		if (!expiresAt) return true;

		const expiresAtTimestamp = parseInt(expiresAt, 10);
		const now = Math.floor(Date.now() / 1000);

		// Consider expired if within 5 minutes of expiration
		return now >= expiresAtTimestamp - 300;
	}
}

export class StravaClient {
	private config: StravaConfig;
	private accessToken: string | null = null;

	constructor(config: StravaConfig) {
		this.config = config;

		// Try to load existing token
		const stored = TokenStore.load();
		if (stored) {
			this.accessToken = stored.access_token;
		}
	}

	/**
	 * Check if user is authenticated
	 */
	isAuthenticated(): boolean {
		return this.accessToken !== null && !TokenStore.isExpired();
	}

	/**
	 * Get stored athlete info
	 */
	getAthlete(): any {
		const stored = TokenStore.load();
		return stored?.athlete;
	}

	/**
	 * Start OAuth flow by redirecting to Strava authorization page
	 */
	authorize(scopes: string[] = ["activity:read_all"]): void {
		const params = new URLSearchParams({
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			response_type: "code",
			approval_prompt: "auto",
			scope: scopes.join(","),
		});

		const authUrl = `${STRAVA_AUTH_BASE}/authorize?${params.toString()}`;
		window.location.href = authUrl;
	}

	/**
	 * Handle OAuth callback and exchange code for token
	 * Call this on your redirect page with the code from URL params
	 */
	async handleCallback(code: string): Promise<boolean> {
		try {
			let tokenResponse: StravaTokenResponse;

			if (this.config.useLocalServer) {
				// Exchange via local server endpoint
				const response = await fetch("/api/strava/token", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ code }),
				});

				if (!response.ok) {
					throw new Error("Token exchange failed");
				}

				tokenResponse = await response.json();
			} else {
				// Direct exchange (requires client_secret in frontend - NOT RECOMMENDED for production)
				// This is only for development/testing
				console.warn("Direct token exchange - client_secret exposed in frontend!");
				throw new Error("Direct exchange not implemented - use local server");
			}

			TokenStore.save(tokenResponse);
			this.accessToken = tokenResponse.access_token;

			return true;
		} catch (error) {
			console.error("OAuth callback failed:", error);
			return false;
		}
	}

	/**
	 * Refresh access token using refresh token
	 */
	async refreshToken(): Promise<boolean> {
		const stored = TokenStore.load();
		if (!stored?.refresh_token) {
			return false;
		}

		try {
			const response = await fetch("/api/strava/refresh", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: stored.refresh_token }),
			});

			if (!response.ok) {
				throw new Error("Token refresh failed");
			}

			const tokenResponse: StravaTokenResponse = await response.json();
			TokenStore.save(tokenResponse);
			this.accessToken = tokenResponse.access_token;

			return true;
		} catch (error) {
			console.error("Token refresh failed:", error);
			TokenStore.clear();
			return false;
		}
	}

	/**
	 * Logout and clear stored tokens
	 */
	logout(): void {
		TokenStore.clear();
		this.accessToken = null;
	}

	/**
	 * Fetch all activities with pagination
	 */
	async fetchAllActivities(
		onProgress?: (count: number, total?: number) => void,
	): Promise<StravaActivity[]> {
		if (!this.accessToken) {
			throw new Error("Not authenticated");
		}

		// Check if token needs refresh
		if (TokenStore.isExpired()) {
			const refreshed = await this.refreshToken();
			if (!refreshed) {
				throw new Error("Token expired and refresh failed");
			}
		}

		const activities: StravaActivity[] = [];
		let page = 1;
		const perPage = 200; // Max allowed by Strava
		let hasMore = true;

		while (hasMore) {
			try {
				const pageActivities = await this.fetchActivitiesPage(page, perPage);

				if (pageActivities.length === 0) {
					hasMore = false;
				} else {
					activities.push(...pageActivities);
					onProgress?.(activities.length);

					if (pageActivities.length < perPage) {
						hasMore = false;
					} else {
						page++;
					}
				}

				// Rate limiting: Strava allows 100 requests per 15 min, 1000 per day
				// Add small delay between requests
				if (hasMore) {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			} catch (error) {
				console.error(`Failed to fetch page ${page}:`, error);
				throw error;
			}
		}

		return activities;
	}

	/**
	 * Fetch a single page of activities
	 */
	private async fetchActivitiesPage(page: number, perPage: number): Promise<StravaActivity[]> {
		const params = new URLSearchParams({
			page: page.toString(),
			per_page: perPage.toString(),
		});

		const response = await fetch(`${STRAVA_API_BASE}/athlete/activities?${params}`, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
			},
		});

		if (!response.ok) {
			if (response.status === 401) {
				// Token expired, try refresh
				const refreshed = await this.refreshToken();
				if (refreshed) {
					// Retry with new token
					return this.fetchActivitiesPage(page, perPage);
				}
				throw new Error("Authentication failed");
			}
			throw new Error(`Strava API error: ${response.status} ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Fetch detailed activity with full polyline (if summary_polyline not sufficient)
	 */
	async fetchActivityDetail(activityId: number): Promise<StravaActivity> {
		if (!this.accessToken) {
			throw new Error("Not authenticated");
		}

		const response = await fetch(`${STRAVA_API_BASE}/activities/${activityId}`, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch activity ${activityId}: ${response.statusText}`);
		}

		return response.json();
	}

	/**
	 * Batch fetch activity details (with rate limiting)
	 */
	async fetchActivityDetails(
		activityIds: number[],
		onProgress?: (count: number, total: number) => void,
	): Promise<StravaActivity[]> {
		const activities: StravaActivity[] = [];

		for (let i = 0; i < activityIds.length; i++) {
			try {
				const activity = await this.fetchActivityDetail(activityIds[i]);
				activities.push(activity);
				onProgress?.(i + 1, activityIds.length);

				// Rate limiting delay
				if (i < activityIds.length - 1) {
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			} catch (error) {
				console.error(`Failed to fetch activity ${activityIds[i]}:`, error);
			}
		}

		return activities;
	}

	/**
	 * Get current rate limit status
	 */
	async getRateLimitStatus(): Promise<{
		shortTerm: { limit: number; usage: number };
		longTerm: { limit: number; usage: number };
	} | null> {
		if (!this.accessToken) {
			return null;
		}

		try {
			const response = await fetch(`${STRAVA_API_BASE}/athlete`, {
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
				},
			});

			const shortLimit = response.headers.get("X-RateLimit-Limit")?.split(",")[0];
			const shortUsage = response.headers.get("X-RateLimit-Usage")?.split(",")[0];
			const longLimit = response.headers.get("X-RateLimit-Limit")?.split(",")[1];
			const longUsage = response.headers.get("X-RateLimit-Usage")?.split(",")[1];

			return {
				shortTerm: {
					limit: shortLimit ? parseInt(shortLimit) : 100,
					usage: shortUsage ? parseInt(shortUsage) : 0,
				},
				longTerm: {
					limit: longLimit ? parseInt(longLimit) : 1000,
					usage: longUsage ? parseInt(longUsage) : 0,
				},
			};
		} catch (error) {
			console.error("Failed to get rate limit status:", error);
			return null;
		}
	}
}

/**
 * Create a singleton instance
 */
let clientInstance: StravaClient | null = null;

export function createStravaClient(config: StravaConfig): StravaClient {
	if (!clientInstance) {
		clientInstance = new StravaClient(config);
	}
	return clientInstance;
}

export function getStravaClient(): StravaClient | null {
	return clientInstance;
}
