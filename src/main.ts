// Main application entry point
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { StravaActivity, ProcessingConfig, WorkerMessage, WorkerResponse } from "./types";
import { createStravaClient, StravaClient } from "./lib/strava";
import { loadState, saveState, clearState } from "./lib/storage";
import { createExplorationLayer, ExplorationCanvasLayer } from "./lib/canvas-layer";
import { createRouteOverlay, RouteOverlayLayer } from "./lib/route-layer";
import { createControls, Controls } from "./ui/controls";

// Configuration
let stravaClientId: string;
const APP_CONFIG = {
	strava: {
		get clientId() {
			return stravaClientId;
		},
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

	// State
	private visitedCells = new Set<string>();
	private processedActivityIds = new Set<number>();
	private currentConfig: ProcessingConfig = APP_CONFIG.processing;
	private allActivities: StravaActivity[] = [];
	private isProcessing = false;
	private saveTimeout?: number;

	async initialize(): Promise<void> {
		console.log("Initializing Exploration Map...");

		await this.fetchConfig();
		this.stravaClient = createStravaClient(APP_CONFIG.strava);

		await this.initializeMap();
		this.initializeWorker();
		this.initializeControls();
		await this.loadSavedState();

		this.handleAuthCallback();
	}

	private async fetchConfig() {
		const res = await fetch("/api/config");
		const config = await res.json();
		stravaClientId = config.STRAVA_CLIENT_ID;
	}

	private async initializeMap(): Promise<void> {
		const container = document.getElementById("map");
		if (!container) throw new Error("Map container not found");

		this.map = new maplibregl.Map({
			container,
			style: APP_CONFIG.map.style,
			center: APP_CONFIG.map.defaultCenter,
			zoom: APP_CONFIG.map.defaultZoom,
		});

		await new Promise<void>((resolve) => this.map!.on("load", () => resolve()));

		this.map.addControl(new maplibregl.NavigationControl(), "top-right");
		this.map.addControl(new maplibregl.FullscreenControl(), "top-right");
		this.map.addControl(
			new maplibregl.GeolocateControl({
				positionOptions: { enableHighAccuracy: true },
				trackUserLocation: true,
			}),
			"top-right",
		);

		this.explorationLayer = createExplorationLayer(this.map, {
			id: "exploration-layer",
			cellSize: this.currentConfig.cellSize,
			fillColor: "#4CAF50",
			fillOpacity: 0.3,
			borderWidth: 0,
		});

		this.routeLayer = createRouteOverlay(this.map, {
			lineColor: "#FF5722",
			lineWidth: 3.5,
			lineOpacity: 0.9,
			showPrivate: !this.currentConfig.skipPrivate,
			privacyDistance: this.currentConfig.privacyDistance,
		});
	}

	private initializeWorker(): void {
		this.worker = new Worker("/dist/worker/processor.js", { type: "module" });
		this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
		this.worker.onerror = (error) => {
			console.error("Worker error:", error);
			this.controls?.showMessage("Processing error occurred", "error");
			this.setProcessingState(false);
		};
	}

	private initializeControls(): void {
		const container = document.getElementById("controls");
		if (!container) throw new Error("Controls container not found");

		this.controls = createControls(container, {
			onPrivacyChange: (s) => this.updatePrivacySettings(s),
			onConfigChange: (c) => this.updateConfig(c),
			onRouteToggle: (v) => this.routeLayer?.setVisibility(v),
			onUnitsToggle: (imp) => {
				this.controls?.setUnits(imp);
				this.routeLayer?.setUnits(imp);
			},
			onRouteStyleChange: (s) => this.routeLayer?.setStyle(s),
			onLocationSelect: (center) => {
				this.map?.jumpTo({ center, zoom: 12 });
			},
		});

		this.controls.setUnits(this.routeLayer?.isImperialUnits?.() ?? false);
		this.routeLayer?.setVisibility(true);
		this.updateAuthUI();
	}

	private async loadSavedState(): Promise<void> {
		try {
			const state = await loadState();
			if (!state) return;

			this.visitedCells = state.visitedCells;
			this.processedActivityIds = state.processedActivityIds;
			this.currentConfig = state.config;
			this.allActivities = state.activities;

			// Restore route layer
			this.routeLayer?.setActivities(state.activities);
			this.routeLayer?.setStyle({ showPrivate: !this.currentConfig.skipPrivate });
			this.routeLayer?.setPrivacyDistance(this.currentConfig.privacyDistance);
			this.controls?.updateRouteActivityTypes(state.activities.map((a) => a.type));

			// Sync worker
			this.sendWorkerMessage({
				type: "init",
				data: {
					visitedCells: Array.from(this.visitedCells),
					processedActivityIds: Array.from(this.processedActivityIds),
					config: this.currentConfig,
					activities: this.allActivities,
				},
			});

			// Request initial render
			if (this.explorationLayer) {
				this.sendWorkerMessage({ type: "process", data: { activities: [] } });
			}

			this.updateStatsUI();
			this.controls?.showMessage(`Loaded ${this.visitedCells.size} cells from cache`, "success");
		} catch (error) {
			console.error("Failed to load saved state:", error);
		}
	}

	private async handleAuthCallback(): Promise<void> {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("code");
		const error = params.get("error");

		if (error) {
			this.controls?.showMessage(`Authentication failed: ${error}`, "error");
			return;
		}

		if (code && this.stravaClient) {
			try {
				const success = await this.stravaClient.handleCallback(code);
				if (success) {
					this.controls?.showMessage("Successfully authenticated!", "success");
					this.updateAuthUI();
					window.history.replaceState({}, document.title, window.location.pathname);
					await this.fetchAndProcessActivities();
				} else {
					this.controls?.showMessage("Authentication failed", "error");
				}
			} catch (e) {
				console.error("Auth error:", e);
				this.controls?.showMessage("Authentication error", "error");
			}
		}
	}

	private updateAuthUI(): void {
		const authBtn = document.getElementById("auth-button") as HTMLButtonElement;
		const userInfo = document.getElementById("user-info");
		const fetchBtn = document.getElementById("fetch-button") as HTMLButtonElement;

		if (!authBtn || !userInfo || !fetchBtn) return;

		if (this.stravaClient?.isAuthenticated()) {
			const athlete = this.stravaClient.getAthlete();
			authBtn.textContent = "Logout";
			authBtn.onclick = () => {
				this.stravaClient?.logout();
				this.updateAuthUI();
				clearState();
				this.controls?.showMessage("Logged out", "info");
			};

			if (athlete) {
				userInfo.textContent = `${athlete.firstname} ${athlete.lastname}`;
				userInfo.style.display = "block";
			}

			fetchBtn.style.display = "block";
			fetchBtn.onclick = () => this.fetchAndProcessActivities();
		} else {
			authBtn.textContent = "Connect Strava";
			authBtn.onclick = () => this.stravaClient?.authorize(["activity:read_all"]);
			userInfo.style.display = "none";
			fetchBtn.style.display = "none";
		}
	}

	private async fetchAndProcessActivities(): Promise<void> {
		if (!this.stravaClient?.isAuthenticated()) return;
		if (this.isProcessing) return;

		try {
			this.setProcessingState(true);
			this.controls?.showMessage("Fetching activities...", "info");

			const activities = await this.stravaClient.fetchAllActivities((count) => {
				this.controls?.updateProgress(count, count, `Fetching... ${count}`);
			});

			this.controls?.showMessage(`Fetched ${activities.length} activities`, "success");
			this.controls?.showProgress(false);

			this.allActivities = activities;
			this.routeLayer?.setActivities(activities);
			this.controls?.updateRouteActivityTypes(activities.map((a) => a.type));

			// Sync worker with full list
			this.sendWorkerMessage({ type: "init", data: { activities } });
			await this.saveCurrentState();

			const newActivities = activities.filter((a) => !this.processedActivityIds.has(a.id));
			if (newActivities.length === 0) {
				this.controls?.showMessage("No new activities to process", "info");
				this.setProcessingState(false);
				return;
			}

			this.controls?.showMessage(`Processing ${newActivities.length} new activities...`, "info");
			this.controls?.showProgress(true);

			this.sendWorkerMessage({
				type: "process",
				data: { activities: newActivities, batchSize: APP_CONFIG.processing.batchSize },
			});
		} catch (error) {
			console.error("Fetch error:", error);
			this.controls?.showMessage("Failed to fetch activities", "error");
			this.setProcessingState(false);
		}
	}

	private handleWorkerMessage(response: WorkerResponse): void {
		const { type, data, progress, total } = response;

		switch (type) {
			case "progress":
				if (data?.message) this.controls?.showMessage(data.message, "info");
				if (progress !== undefined && total !== undefined) {
					this.controls?.updateProgress(progress, total);
				}

				// Handle config updates requiring reprocessing
				if (data?.configUpdated && data?.needsReprocess) {
					if (data.noActivities) {
						// Seed worker if needed
						if (this.allActivities.length > 0) {
							this.controls?.showMessage("Seeding worker for reprocess...", "info");
							this.sendWorkerMessage({ type: "init", data: { activities: this.allActivities } });
							this.sendWorkerMessage({ type: "updateConfig", data: this.currentConfig });
						} else {
							this.controls?.showMessage("No activities to reprocess. Fetch first.", "warning");
						}
					} else if (!data.queued) {
						this.setProcessingState(true);
						this.controls?.showProgress(true);
						this.controls?.showMessage("Reprocessing...", "info");
					}
				}
				break;

			case "rectangles":
				if (data) {
					if (data.reprocessing) {
						this.setProcessingState(true);
						this.controls?.showProgress(true);
					}
					this.updateMapAndState(data);
					if (progress !== undefined && total !== undefined) {
						this.controls?.updateProgress(progress, total);
					}
					this.saveStatePeriodically();
				}
				break;

			case "complete":
				this.setProcessingState(false);
				if (data) this.updateMapAndState(data);
				this.controls?.showMessage("Processing complete!", "success");
				this.saveCurrentState();
				break;

			case "error":
				this.setProcessingState(false);
				this.controls?.showMessage(`Error: ${data?.message}`, "error");
				break;
		}
	}

	private updateMapAndState(data: any): void {
		if (data.visitedCells) this.visitedCells = new Set(data.visitedCells);
		if (data.processedActivityIds) this.processedActivityIds = new Set(data.processedActivityIds);
		if (data.rectangles && this.explorationLayer) {
			this.explorationLayer.setRectangles(data.rectangles);
		}

		// Update stats if available, or fall back to current state
		const cellCount = data.totalCells ?? this.visitedCells.size;
		const rectCount = data.rectangles?.length;

		this.updateStatsUI(cellCount, rectCount);
	}

	private updateStatsUI(cellCount?: number, rectCount?: number): void {
		const cells = cellCount ?? this.visitedCells.size;
		this.controls?.updateStats({
			cells,
			activities: this.processedActivityIds.size,
			rectangles: rectCount,
			area: (cells * Math.pow(this.currentConfig.cellSize, 2)) / 1_000_000,
		});
	}

	private setProcessingState(isProcessing: boolean): void {
		this.isProcessing = isProcessing;
		this.controls?.setProcessing(isProcessing);
	}

	private sendWorkerMessage(message: WorkerMessage): void {
		this.worker?.postMessage(message);
	}

	private updatePrivacySettings(settings: any): void {
		// Only act if explicit settings provided
		if (settings.enabled === undefined && settings.skipPrivateActivities === undefined) return;

		const enabled = settings.enabled ?? this.currentConfig.privacyDistance > 0;
		const skipPrivate = settings.skipPrivateActivities ?? this.currentConfig.skipPrivate;

		this.currentConfig = {
			...this.currentConfig,
			privacyDistance: enabled ? 400 : 0,
			skipPrivate,
		};

		this.sendWorkerMessage({ type: "updateConfig", data: this.currentConfig });

		// Update route layer immediately
		this.routeLayer?.setStyle({ showPrivate: !this.currentConfig.skipPrivate });
		this.routeLayer?.setPrivacyDistance(this.currentConfig.privacyDistance);
	}

	private updateConfig(config: Partial<ProcessingConfig>): void {
		this.currentConfig = { ...this.currentConfig, ...config };
		if (config.cellSize && this.explorationLayer) {
			this.explorationLayer.setCellSize(config.cellSize);
		}
		this.sendWorkerMessage({ type: "updateConfig", data: this.currentConfig });
	}

	private async saveCurrentState(): Promise<void> {
		try {
			await saveState(
				this.visitedCells,
				this.processedActivityIds,
				this.currentConfig,
				this.allActivities,
			);
			console.log("State saved");
		} catch (error) {
			console.error("Failed to save state:", error);
		}
	}

	private saveStatePeriodically(): void {
		if (this.saveTimeout) clearTimeout(this.saveTimeout);
		this.saveTimeout = window.setTimeout(() => this.saveCurrentState(), 2000);
	}

	destroy(): void {
		if (this.saveTimeout) clearTimeout(this.saveTimeout);
		this.worker?.terminate();
		this.routeLayer?.remove();
		this.map?.remove();
		this.controls?.destroy();
	}
}

// Initialization
let app: ExplorationMapApp;

// @ts-ignore
if (import.meta.hot) {
	// @ts-ignore
	import.meta.hot.dispose(() => app?.destroy());
}

const init = async () => {
	if (app) app.destroy();
	app = new ExplorationMapApp();
	try {
		await app.initialize();
		console.log("App initialized");
	} catch (e) {
		console.error("Init failed:", e);
		alert("Failed to initialize application.");
	}
};

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
