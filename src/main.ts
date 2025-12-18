// Main application entry point
// Coordinates MapLibre map, Web Worker, UI controls, and Strava API

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { StravaActivity, ProcessingConfig, Rectangle } from "./types";
import { createStravaClient, StravaClient } from "./lib/strava";
import { loadState, saveState, getStorageStats } from "./lib/storage";
import { createExplorationLayer, ExplorationCanvasLayer } from "./lib/canvas-layer";
import { createRouteOverlay, RouteOverlayLayer } from "./lib/route-layer";
import { createControls, Controls } from "./ui/controls";
import type { WorkerMessage, WorkerResponse } from "./types";

let clientId: string;

// Application configuration (clientId will be set after fetching from server)
const APP_CONFIG = {
	strava: {
		get clientId() {
			return clientId;
		}, // always up-to-date
		redirectUri: window.location.origin + "",
		useLocalServer: true,
	},
	map: {
		defaultCenter: [11.582, 48.1351] as [number, number], // Munich
		defaultZoom: 12,
		style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
	},
	processing: {
		cellSize: 25,
		samplingStep: 12.5,
		privacyDistance: 400,
		snapToGrid: false,
		skipPrivate: false,
		batchSize: 20,
	},
};

class ExplorationMapApp {
	private map?: MapLibreMap;
	private stravaClient?: StravaClient;
	private worker?: Worker;
	private controls?: Controls;
	private explorationLayer?: ExplorationCanvasLayer;
	private routeLayer?: RouteOverlayLayer;

	private visitedCells = new Set<string>();
	private processedActivityIds = new Set<number>();
	private currentConfig: ProcessingConfig = APP_CONFIG.processing;
	private allActivities: StravaActivity[] = [];

	private isProcessing = false;
	private reprocessNotificationShown = false;

	async initialize(): Promise<void> {
		console.log("Initializing Exploration Map...");

		// Fetch config from server and update clientId
		await this.fetchConfig();

		this.initializeStrava();

		await this.initializeMap();

		this.initializeWorker();

		this.initializeControls();

		// Try to load saved state
		await this.loadSavedState();

		// Handle OAuth callback if present
		this.handleAuthCallback();
	}

	/**
	 * Initialize Strava client
	 */
	private initializeStrava(): void {
		this.stravaClient = createStravaClient(APP_CONFIG.strava);
	}

	/**
	 * Fetch Strava client ID from server and update clientId variable
	 */
	private async fetchConfig() {
		const res = await fetch("/api/config");
		const config = await res.json();
		clientId = config.STRAVA_CLIENT_ID;
	}

	/**
	 * Initialize MapLibre map
	 */
	private async initializeMap(): Promise<void> {
		const container = document.getElementById("map");
		if (!container) {
			throw new Error("Map container not found");
		}

		this.map = new maplibregl.Map({
			container,
			style: APP_CONFIG.map.style,
			center: APP_CONFIG.map.defaultCenter,
			zoom: APP_CONFIG.map.defaultZoom,
		});

		// Wait for map to load
		await new Promise<void>((resolve) => {
			this.map!.on("load", () => resolve());
		});

		// Add navigation and fullscreen controls
		this.map.addControl(new maplibregl.NavigationControl(), "top-right");
		this.map.addControl(new maplibregl.FullscreenControl(), "top-right");

		// Add geolocate control
		this.map.addControl(
			new maplibregl.GeolocateControl({
				positionOptions: {
					enableHighAccuracy: true,
				},
				trackUserLocation: true,
			}),
			"top-right",
		);

		// Create exploration layer
		this.explorationLayer = createExplorationLayer(this.map, {
			id: "exploration-layer",
			cellSize: this.currentConfig.cellSize,
			fillColor: "#4CAF50",
			fillOpacity: 0.3,
			borderWidth: 0,
		});

		// route overlay layer
		this.routeLayer = createRouteOverlay(this.map, {
			lineColor: "#FF5722",
			lineWidth: 3.5,
			lineOpacity: 0.9,
			showPrivate: !this.currentConfig.skipPrivate,
			privacyDistance: this.currentConfig.privacyDistance,
		});

		console.log("Map initialized");
	}

	/**
	 * Initialize Web Worker
	 */
	private initializeWorker(): void {
		// Create worker from separate file
		this.worker = new Worker("/dist/worker/processor.js", { type: "module" });

		// Handle worker messages
		this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			this.handleWorkerMessage(event.data);
		};

		this.worker.onerror = (error) => {
			console.error("Worker error:", error);
			this.controls?.showMessage("Processing error occurred", "error");
			this.isProcessing = false;
			this.controls?.setProcessing(false);
		};

		console.log("Worker initialized");
	}

	/**
	 * Initialize UI controls
	 */
	private initializeControls(): void {
		const controlsContainer = document.getElementById("controls");
		if (!controlsContainer) {
			throw new Error("Controls container not found");
		}

		this.controls = createControls(controlsContainer, {
			onPrivacyChange: (settings) => this.updatePrivacySettings(settings),
			onConfigChange: (config) => this.updateConfig(config),
			onRouteToggle: (visible) => this.toggleRouteOverlay(visible),
			onUnitsToggle: (imperial) => this.toggleUnits(imperial),
			onRouteStyleChange: (style) => this.updateRouteStyle(style),
		});

		// Ensure controls reflect current units setting from the route layer
		this.controls?.setUnits(this.routeLayer?.isImperialUnits?.() ?? false);

		// Ensure route layer visibility is set to default (true/visible)
		this.routeLayer?.setVisibility(true);

		// Update auth button
		this.updateAuthUI();

		console.log("Controls initialized");
	}

	/**
	 * Load saved state from IndexedDB
	 */
	private async loadSavedState(): Promise<void> {
		try {
			const state = await loadState();

			if (state) {
				console.log("Loaded state from storage:", {
					cellCount: state.visitedCells.size,
					activityCount: state.processedActivityIds.size,
					activitiesArray: state.activities.length,
					firstActivity: state.activities[0],
				});

				this.visitedCells = state.visitedCells;
				this.processedActivityIds = state.processedActivityIds;
				this.currentConfig = state.config;
				this.allActivities = state.activities;

				// Update route layer with loaded activities
				console.log("Setting activities on route layer, count:", state.activities.length);
				this.routeLayer?.setActivities(state.activities);
				// Ensure route overlay reflects privacy config (hide private, trim start/end)
				this.routeLayer?.setStyle({ showPrivate: !this.currentConfig.skipPrivate });
				this.routeLayer?.setPrivacyDistance(this.currentConfig.privacyDistance);
				// Update controls with activity types present
				this.controls?.updateRouteActivityTypes(state.activities.map((a) => a.type));

				// Update worker with loaded state (include activities so worker can reprocess if needed)
				this.sendWorkerMessage({
					type: "init",
					data: {
						visitedCells: Array.from(this.visitedCells),
						processedActivityIds: Array.from(this.processedActivityIds),
						config: this.currentConfig,
						activities: this.allActivities || [],
					},
				});

				// Update map layer
				if (this.explorationLayer && this.worker) {
					// Request rectangles from worker
					this.sendWorkerMessage({ type: "process", data: { activities: [] } });
				}

				// Update UI
				this.controls?.updateStats({
					cells: this.visitedCells.size,
					activities: this.processedActivityIds.size,
				});

				this.controls?.showMessage(`Loaded ${this.visitedCells.size} cells from cache`, "success");

				console.log("Loaded saved state:", {
					cells: this.visitedCells.size,
					activities: this.processedActivityIds.size,
				});
			}
		} catch (error) {
			console.error("Failed to load saved state:", error);
		}
	}

	/**
	 * Handle OAuth callback
	 */
	private async handleAuthCallback(): Promise<void> {
		const urlParams = new URLSearchParams(window.location.search);
		const code = urlParams.get("code");
		const error = urlParams.get("error");

		if (error) {
			this.controls?.showMessage(`Authentication failed: ${error}`, "error");
			return;
		}

		if (code && this.stravaClient) {
			try {
				const success = await this.stravaClient.handleCallback(code);

				if (success) {
					this.controls?.showMessage("Successfully authenticated with Strava!", "success");
					this.updateAuthUI();

					// Clear URL params
					window.history.replaceState({}, document.title, window.location.pathname);

					// Auto-start fetching activities
					await this.fetchAndProcessActivities();
				} else {
					this.controls?.showMessage("Authentication failed", "error");
				}
			} catch (error) {
				console.error("Auth callback error:", error);
				this.controls?.showMessage("Authentication error", "error");
			}
		}
	}

	/**
	 * Update authentication UI
	 */
	private updateAuthUI(): void {
		const authButton = document.getElementById("auth-button") as HTMLButtonElement;
		const userInfo = document.getElementById("user-info");

		if (!authButton || !userInfo) return;

		if (this.stravaClient?.isAuthenticated()) {
			const athlete = this.stravaClient.getAthlete();
			authButton.textContent = "Logout";
			authButton.onclick = () => this.logout();

			if (athlete) {
				userInfo.textContent = `${athlete.firstname} ${athlete.lastname}`;
				userInfo.style.display = "block";
			}

			// Show fetch button
			const fetchButton = document.getElementById("fetch-button") as HTMLButtonElement;
			if (fetchButton) {
				fetchButton.style.display = "block";
				fetchButton.onclick = () => this.fetchAndProcessActivities();
			}
		} else {
			authButton.textContent = "Connect Strava";
			authButton.onclick = () => this.login();
			userInfo.textContent = "";
			userInfo.style.display = "none";

			const fetchButton = document.getElementById("fetch-button");
			if (fetchButton) {
				fetchButton.style.display = "none";
			}
		}
	}

	/**
	 * Login with Strava
	 */
	private login(): void {
		if (!this.stravaClient) return;
		this.stravaClient.authorize(["activity:read_all"]);
	}

	/**
	 * Logout
	 */
	private logout(): void {
		if (!this.stravaClient) return;
		this.stravaClient.logout();
		this.updateAuthUI();
		this.controls?.showMessage("Logged out", "info");
	}

	/**
	 * Toggle route overlay visibility
	 */
	private toggleRouteOverlay(visible: boolean): void {
		this.routeLayer?.setVisibility(visible);
	}

	/**
	 * Toggle units between metric and imperial
	 */
	private toggleUnits(imperial: boolean): void {
		// Update controls UI (labels/formatting) and the route layer's unit handling
		this.controls?.setUnits(imperial);
		this.routeLayer?.setUnits(imperial);
	}

	/**
	 * Update route overlay style
	 */
	private updateRouteStyle(style: {
		lineWidth?: number;
		lineOpacity?: number;
		colorByType?: boolean;
	}): void {
		this.routeLayer?.setStyle(style);
	}

	/**
	 * Fetch and process activities
	 */
	private async fetchAndProcessActivities(): Promise<void> {
		if (!this.stravaClient?.isAuthenticated()) {
			this.controls?.showMessage("Please authenticate with Strava first", "warning");
			return;
		}

		if (this.isProcessing) {
			this.controls?.showMessage("Already processing activities", "warning");
			return;
		}

		try {
			this.isProcessing = true;
			this.controls?.setProcessing(true);
			this.controls?.showMessage("Fetching activities from Strava...", "info");

			// Fetch all activities
			const activities = await this.stravaClient.fetchAllActivities((count) => {
				this.controls?.updateProgress(count, count, `Fetching activities... ${count} loaded`);
			});

			this.controls?.showMessage(`Fetched ${activities.length} activities`, "success");
			// Hide the fetch-related progress UI now that fetching is done
			this.controls?.showProgress(false);

			// Store all activities for route overlay
			this.allActivities = activities;
			this.routeLayer?.setActivities(activities);
			// Inform worker of the full activity set so it can reprocess if config changes
			this.sendWorkerMessage({ type: "init", data: { activities } });
			// Update controls with activity types present
			this.controls?.updateRouteActivityTypes(activities.map((a) => a.type));

			// Save activities immediately so they persist on refresh
			await this.saveCurrentState();

			// Filter out already processed activities
			const newActivities = activities.filter((a) => !this.processedActivityIds.has(a.id));

			if (newActivities.length === 0) {
				this.controls?.showMessage("No new activities to process", "info");
				this.isProcessing = false;
				this.controls?.setProcessing(false);
				return;
			}

			this.controls?.showMessage(`Processing ${newActivities.length} new activities...`, "info");
			// Show the progress UI for worker processing
			this.controls?.showProgress(true);

			// Send to worker for processing
			this.sendWorkerMessage({
				type: "process",
				data: {
					activities: newActivities,
					batchSize: APP_CONFIG.processing.batchSize,
				},
			});
		} catch (error) {
			console.error("Failed to fetch activities:", error);
			this.controls?.showMessage("Failed to fetch activities", "error");
			this.isProcessing = false;
			this.controls?.setProcessing(false);
			this.reprocessNotificationShown = false;
		}
	}

	/**
	 * Handle worker messages
	 */
	private handleWorkerMessage(response: WorkerResponse): void {
		switch (response.type) {
			case "progress":
				// Show any informational message from the worker (e.g., queued reprocess)
				if (response.data?.message) {
					this.controls?.showMessage(response.data.message, "info");
				}

				// If worker reports a config update that requires reprocessing, decide how to react
				if (response.data?.configUpdated) {
					const needsReprocess = !!response.data?.needsReprocess;
					if (needsReprocess) {
						// Worker indicates no activities are stored (can't reprocess on its own)
						if (response.data?.noActivities) {
							if (this.allActivities && this.allActivities.length > 0) {
								this.controls?.showMessage(
									"Seeding worker with activities and starting reprocess...",
									"info",
								);
								// Give the worker the activities it needs, then re-send the config to trigger reprocessing
								this.sendWorkerMessage({ type: "init", data: { activities: this.allActivities } });
								this.sendWorkerMessage({ type: "updateConfig", data: this.currentConfig });
							} else {
								// No local activities available to seed the worker: inform the user and don't clear visuals
								this.controls?.showMessage(
									"No activities available locally to reprocess. Fetch activities to apply privacy settings.",
									"warning",
								);
							}
							// Do not clear visuals/stats here; wait for worker rectangle updates (if any)
						} else if (response.data?.queued) {
							// Worker queued the reprocess until current processing completes -> do not clear visuals yet
							this.controls?.showMessage(
								"Reprocess queued until current processing completes",
								"info",
							);
						} else {
							// Worker will start reprocessing immediately; update UI to reflect processing state,
							// but do not clear the existing rectangles/stats until new data arrives
							if (!this.reprocessNotificationShown) {
								this.controls?.showMessage(
									"Configuration updated — reprocessing activities...",
									"info",
								);
								this.reprocessNotificationShown = true;
							}
							this.isProcessing = true;
							this.controls?.setProcessing(true);
							this.controls?.showProgress(true);
						}
					} else {
						this.controls?.showMessage("Configuration updated", "success");
					}
				}

				// Regular progress update (if present)
				if (response.progress !== undefined && response.total !== undefined) {
					this.controls?.updateProgress(response.progress, response.total);
				}
				break;

			case "rectangles":
				// Update from worker response
				if (response.data) {
					const { rectangles, totalCells, visitedCells, processedActivityIds, reprocessing } =
						response.data;

					// If this is a reprocessing run, mark UI as processing (but don't clear old visuals here;
					// the new rectangles will replace them as the worker sends updates)
					if (reprocessing) {
						this.isProcessing = true;
						this.controls?.setProcessing(true);
						if (!this.reprocessNotificationShown) {
							this.controls?.showMessage("Reprocessing activities...", "info");
							this.reprocessNotificationShown = true;
						}
						this.controls?.showProgress(true);
					}

					// Update local state
					if (visitedCells) {
						this.visitedCells = new Set(visitedCells);
					}
					if (processedActivityIds) {
						this.processedActivityIds = new Set(processedActivityIds);
					}

					// Update map (worker will send partial rectangle updates during reprocess)
					if (rectangles && this.explorationLayer) {
						this.explorationLayer.setRectangles(rectangles);
					}

					// Update UI (progress/stats)
					this.controls?.updateProgress(response.progress || 0, response.total || 0);

					this.controls?.updateStats({
						cells: totalCells,
						activities: this.processedActivityIds.size,
						rectangles: rectangles?.length || 0,
						area: this.calculateArea(totalCells),
					});

					// Save state periodically
					this.saveStatePeriodically();
				}
				break;

			case "complete":
				this.isProcessing = false;
				this.controls?.setProcessing(false);
				// Reset the one-time reprocess notification so a future reprocess will notify again
				this.reprocessNotificationShown = false;

				if (response.data?.rectangles && this.explorationLayer) {
					this.explorationLayer.setRectangles(response.data.rectangles);
				}

				this.controls?.showMessage("Processing complete!", "success");

				// Final save
				this.saveCurrentState();

				break;

			case "error":
				this.isProcessing = false;
				this.controls?.setProcessing(false);
				this.controls?.showMessage(`Error: ${response.data?.message}`, "error");
				break;
		}
	}

	/**
	 * Send message to worker
	 */
	private sendWorkerMessage(message: WorkerMessage): void {
		this.worker?.postMessage(message);
	}

	/**
	 * Update privacy settings
	 */
	private updatePrivacySettings(settings: any): void {
		// When enabled, use a fixed 400m trim for both start and end.
		const enabledProvided = typeof settings.enabled !== "undefined";
		const skipProvided = typeof settings.skipPrivateActivities !== "undefined";

		// If this change is only the slider (no explicit toggle/skip update), ignore it.
		if (!enabledProvided && !skipProvided) {
			return;
		}

		const enabled = enabledProvided ? !!settings.enabled : this.currentConfig.privacyDistance > 0;
		const skipPrivate = skipProvided
			? !!settings.skipPrivateActivities
			: this.currentConfig.skipPrivate;

		this.currentConfig = {
			...this.currentConfig,
			// Use fixed 400 meters when enabled; otherwise 0 (disabled)
			privacyDistance: enabled ? 400 : 0,
			skipPrivate,
		};

		console.debug("updatePrivacySettings (toggle-only)", {
			settings,
			currentConfig: this.currentConfig,
		});

		// Notify worker about the config change (worker will reprocess when needed)
		this.sendWorkerMessage({
			type: "updateConfig",
			data: this.currentConfig,
		});

		// Update route overlay immediately so polylines reflect the toggled privacy setting
		this.routeLayer?.setStyle({ showPrivate: !this.currentConfig.skipPrivate });
		this.routeLayer?.setPrivacyDistance(this.currentConfig.privacyDistance);
	}

	/**
	 * Update processing config
	 */
	private updateConfig(config: Partial<ProcessingConfig>): void {
		this.currentConfig = { ...this.currentConfig, ...config };

		if (config.cellSize && this.explorationLayer) {
			this.explorationLayer.setCellSize(config.cellSize);
		}

		this.sendWorkerMessage({
			type: "updateConfig",
			data: this.currentConfig,
		});
	}

	/**
	 * Save current state to IndexedDB
	 */
	private async saveCurrentState(): Promise<void> {
		try {
			console.log("Saving activities:", {
				totalActivities: this.allActivities.length,
				activitiesWithPolylines: this.allActivities.filter(
					(a) => a.map?.summary_polyline || a.map?.polyline,
				).length,
				firstActivity: this.allActivities[0],
			});

			await saveState(
				this.visitedCells,
				this.processedActivityIds,
				this.currentConfig,
				this.allActivities,
			);
			console.log("State saved", {
				cellCount: this.visitedCells.size,
				activityCount: this.processedActivityIds.size,
				activitiesWithPolylines: this.allActivities.length,
			});
		} catch (error) {
			console.error("Failed to save state:", error);
		}
	}

	/**
	 * Save state periodically (throttled)
	 */
	private saveTimeout?: number;
	private saveStatePeriodically(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}

		this.saveTimeout = window.setTimeout(() => {
			this.saveCurrentState();
		}, 2000);
	}

	/**
	 * Export data as JSON
	 */

	/**
	 * Calculate explored area in km²
	 */
	private calculateArea(cellCount: number): number {
		const cellAreaMeters = this.currentConfig.cellSize * this.currentConfig.cellSize;
		const totalAreaMeters = cellCount * cellAreaMeters;
		return totalAreaMeters / 1_000_000; // Convert to km²
	}
}

// Initialize app when DOM is ready
let app: ExplorationMapApp;

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", initApp);
} else {
	initApp();
}

async function initApp() {
	app = new ExplorationMapApp();

	try {
		await app.initialize();
		console.log("App initialized successfully");
	} catch (error) {
		console.error("Failed to initialize app:", error);
		alert("Failed to initialize application. Check console for details.");
	}
}

// Export for debugging
app = new ExplorationMapApp();
(window as any).app = app;
