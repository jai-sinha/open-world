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
import { createSidebar, Sidebar } from "./ui/sidebar";
import { CityManager } from "./lib/geocoding/city-manager";
import { setRoadPMTilesURL } from "./lib/tiles";

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
		style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
	},
	processing: {
		cellSize: 50,
		samplingStep: 25,
		privacyDistance: 0,
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
	private sidebar?: Sidebar;
	private explorationLayer?: ExplorationCanvasLayer;
	private routeLayer?: RouteOverlayLayer;
	private cityManager?: CityManager;
	private tilesBaseUrl?: string;
	private cityOutlineSourceId = "city-outline-highlight";
	private cityOutlineLayerId = "city-outline-highlight-layer";
	private cityOutlineAnimationFrame?: number;

	// State
	private visitedCells = new Set<number>();
	private processedActivityIds = new Set<number>();
	private currentConfig: ProcessingConfig = APP_CONFIG.processing;
	private allActivities: StravaActivity[] = [];
	private isProcessing = false;
	private saveTimeout?: number;
	private statsDebounceTimer?: number;

	async initialize(): Promise<void> {
		await this.fetchConfig();
		this.stravaClient = createStravaClient(APP_CONFIG.strava);

		await this.initializeMap();
		this.initializeWorker();
		this.initializeControls();

		this.cityManager = new CityManager(
			this.visitedCells,
			this.currentConfig.cellSize,
			this.tilesBaseUrl,
		);

		await this.loadSavedState();

		this.handleAuthCallback();
	}

	private async fetchConfig() {
		const res = await fetch("/api/config");
		const config = await res.json();
		stravaClientId = config.STRAVA_CLIENT_ID;
		const tilesUrl = config.TILES_BASE_URL || config.ROAD_PM_TILES_URL;
		this.tilesBaseUrl = tilesUrl;
		if (tilesUrl) setRoadPMTilesURL(tilesUrl);
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

		this.map.on("moveend", () => {
			if (this.statsDebounceTimer) clearTimeout(this.statsDebounceTimer);
			this.statsDebounceTimer = window.setTimeout(() => this.updateStatsUI(), 250);
		});

		this.explorationLayer = createExplorationLayer(this.map, {
			id: "exploration-layer",
			cellSize: this.currentConfig.cellSize,
			fillColor: "#4CAF50",
			fillOpacity: 0.3,
			borderWidth: 0,
		});

		this.routeLayer = createRouteOverlay(this.map, {
			lineColor: "#FF5722",
			lineWidth: 4.5,
			lineOpacity: 0.5,
			showPrivate: !this.currentConfig.skipPrivate,
			privacyDistance: this.currentConfig.privacyDistance,
			onRouteClick: (features) => this.sidebar?.show(features),
		});

		this.map.addSource(this.cityOutlineSourceId, {
			type: "geojson",
			data: { type: "FeatureCollection", features: [] },
		});

		this.map.addLayer({
			id: this.cityOutlineLayerId,
			type: "line",
			source: this.cityOutlineSourceId,
			paint: {
				"line-color": "#000000",
				"line-width": 4,
				"line-opacity": 0,
				"line-dasharray": [3, 2],
			},
			layout: {
				"line-cap": "round",
				"line-join": "round",
			},
		});
	}

	private initializeWorker(): void {
		this.worker = new Worker("/worker/processor.js", { type: "module" });
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

		this.sidebar = createSidebar(document.body);

		this.controls = createControls(container, {
			onPrivacyChange: (s) => this.updatePrivacySettings(s),
			onConfigChange: (c) => this.updateConfig(c),
			onRouteToggle: (v) => this.routeLayer?.setVisibility(v),
			onUnitsToggle: (imp) => {
				this.controls?.setUnits(imp);
				this.routeLayer?.setUnits(imp);
				this.sidebar?.setUnits(imp);
			},
			onRouteStyleChange: (s) => this.routeLayer?.setStyle(s),
			onFromDateChange: (fromDate) => this.routeLayer?.setFromDate(fromDate),
			onToDateChange: (toDate) => this.routeLayer?.setToDate(toDate),
			onLocationSelect: (center) => {
				this.map?.jumpTo({ center, zoom: 12 });
			},
			onCityJump: ({ center, outline }) => {
				if (this.map && outline && outline.length > 0) {
					let minLng = Infinity;
					let minLat = Infinity;
					let maxLng = -Infinity;
					let maxLat = -Infinity;

					for (const ring of outline) {
						for (const [lng, lat] of ring) {
							if (lng < minLng) minLng = lng;
							if (lat < minLat) minLat = lat;
							if (lng > maxLng) maxLng = lng;
							if (lat > maxLat) maxLat = lat;
						}
					}

					if (
						Number.isFinite(minLng) &&
						Number.isFinite(minLat) &&
						Number.isFinite(maxLng) &&
						Number.isFinite(maxLat)
					) {
						this.map.fitBounds(
							[
								[minLng, minLat],
								[maxLng, maxLat],
							],
							{
								padding: 40,
								maxZoom: 14,
								duration: 600,
							},
						);
					} else {
						this.map.jumpTo({ center, zoom: 12 });
					}

					this.flashCityOutline(outline);
				} else {
					this.map?.jumpTo({ center, zoom: 12 });
				}
			},
		});

		this.controls.setUnits(this.routeLayer?.isImperialUnits?.() ?? false);
		this.sidebar?.setUnits(this.routeLayer?.isImperialUnits?.() ?? false);
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
			this.controls?.updateRouteActivities(state.activities);
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

			this.cityManager?.updateVisitedCells(this.visitedCells);
			if (this.allActivities.length > 0) {
				this.cityManager?.discoverCitiesFromActivities(this.allActivities);
			}

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

	private flashCityOutline(outline: [number, number][][]): void {
		if (!this.map) return;

		if (this.cityOutlineAnimationFrame) {
			cancelAnimationFrame(this.cityOutlineAnimationFrame);
			this.cityOutlineAnimationFrame = undefined;
		}

		const source = this.map.getSource(this.cityOutlineSourceId) as
			| maplibregl.GeoJSONSource
			| undefined;
		if (!source) return;

		source.setData({
			type: "FeatureCollection",
			features: [
				{
					type: "Feature",
					properties: {},
					geometry: {
						type: "MultiLineString",
						coordinates: outline,
					},
				},
			],
		});

		const fadeInMs = 150;
		const holdMs = 1500;
		const fadeOutMs = 250;
		const maxOpacity = 0.75;
		const start = performance.now();

		const animate = (now: number) => {
			if (!this.map) return;

			const elapsed = now - start;
			let opacity = 0;

			if (elapsed <= fadeInMs) {
				opacity = (elapsed / fadeInMs) * maxOpacity;
			} else if (elapsed <= fadeInMs + holdMs) {
				opacity = maxOpacity;
			} else if (elapsed <= fadeInMs + holdMs + fadeOutMs) {
				const fadeOutElapsed = elapsed - fadeInMs - holdMs;
				opacity = maxOpacity * (1 - fadeOutElapsed / fadeOutMs);
			} else {
				this.map.setPaintProperty(this.cityOutlineLayerId, "line-opacity", 0);
				source.setData({ type: "FeatureCollection", features: [] });
				this.cityOutlineAnimationFrame = undefined;
				return;
			}

			this.map.setPaintProperty(this.cityOutlineLayerId, "line-opacity", opacity);
			this.cityOutlineAnimationFrame = requestAnimationFrame(animate);
		};

		this.cityOutlineAnimationFrame = requestAnimationFrame(animate);
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
			authBtn.textContent = `Logout ${athlete.firstname} ${athlete.lastname}`;
			authBtn.onclick = () => {
				this.stravaClient?.logout();
				this.updateAuthUI();
				clearState();
				this.controls?.showMessage("Logged out", "info");
			};

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
				this.controls?.reportProgress(count, count, `Fetching... ${count}`);
			});

			this.controls?.showMessage(`Fetched ${activities.length} activities`, "success");

			this.allActivities = activities;
			this.routeLayer?.setActivities(activities);
			this.controls?.updateRouteActivities(activities);
			this.controls?.updateRouteActivityTypes(activities.map((a) => a.type));

			let lat: number | undefined;
			let long: number | undefined;

			for (const activity of activities) {
				const coords = activity.start_latlng as [number, number] | null | undefined;
				if (!coords) continue;

				const [candidateLat, candidateLong] = coords;
				if (!Number.isNaN(candidateLat) && !Number.isNaN(candidateLong)) {
					lat = candidateLat;
					long = candidateLong;
					break;
				}
			}

			if (lat === undefined || long === undefined) {
				throw new Error("No activity with valid location data found");
			}

			this.map?.jumpTo({ center: [long, lat], zoom: 12 });

			this.cityManager?.discoverCitiesFromActivities(activities);

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
					this.controls?.reportProgress(progress, total);
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
						this.controls?.showMessage("Reprocessing...", "info");
					}
				}
				break;

			case "rectangles":
				if (data) {
					if (data.reprocessing) {
						this.setProcessingState(true);
					}
					this.updateMapAndState(data);
					if (progress !== undefined && total !== undefined) {
						this.controls?.reportProgress(progress, total);
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
		if (data.visitedCells) {
			this.visitedCells = new Set<number>(data.visitedCells);
			this.cityManager?.updateVisitedCells(this.visitedCells);
		}
		if (data.processedActivityIds) this.processedActivityIds = new Set(data.processedActivityIds);
		if (data.rectangles && this.explorationLayer) {
			this.explorationLayer.setRectangles(data.rectangles);
		}

		// Update stats if available, or fall back to current state
		const cellCount = data.totalCells ?? this.visitedCells.size;

		this.updateStatsUI(cellCount);
	}

	private async updateStatsUI(cellCount?: number): Promise<void> {
		const cells = cellCount ?? this.visitedCells.size;
		const viewportStats = await this.calculateViewportStats();

		const totalDistanceKm = this.allActivities.reduce((sum, activity) => {
			return sum + (activity.distance || 0) / 1000;
		}, 0);

		this.controls?.updateStats({
			cells,
			activities: this.processedActivityIds.size,
			distance: totalDistanceKm,
			area: (cells * Math.pow(this.currentConfig.cellSize, 2)) / 1_000_000,
			viewportExplored: viewportStats,
		});
	}

	private async calculateViewportStats(): Promise<number> {
		if (!this.map || !this.cityManager) return 0;
		if (this.map.getZoom() < 11) return -1;

		const bounds = this.map.getBounds();
		const ne = bounds.getNorthEast();
		const sw = bounds.getSouthWest();

		return this.cityManager.calculateViewportStats({
			minLat: sw.lat,
			maxLat: ne.lat,
			minLng: sw.lng,
			maxLng: ne.lng,
		});
	}

	private setProcessingState(isProcessing: boolean): void {
		this.isProcessing = isProcessing;
		if (isProcessing) {
			this.controls?.beginProcessing();
		} else {
			this.controls?.endProcessing();
		}
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

		// Update route layer immediately
		this.routeLayer?.setStyle({ showPrivate: !this.currentConfig.skipPrivate });
		this.routeLayer?.setPrivacyDistance(this.currentConfig.privacyDistance);
	}

	private updateConfig(config: Partial<ProcessingConfig>): void {
		this.currentConfig = { ...this.currentConfig, ...config };
		if (config.cellSize && this.explorationLayer) {
			this.explorationLayer.setCellSize(config.cellSize);
			this.cityManager = new CityManager(
				this.visitedCells,
				this.currentConfig.cellSize,
				this.tilesBaseUrl,
			);
			if (this.allActivities.length > 0) {
				this.cityManager.discoverCitiesFromActivities(this.allActivities);
			}
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
		} catch (error) {
			console.error("Failed to save state:", error);
		}
	}

	private saveStatePeriodically(): void {
		if (this.saveTimeout) clearTimeout(this.saveTimeout);
		this.saveTimeout = window.setTimeout(() => this.saveCurrentState(), 2000);
	}

	destroy(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
			this.saveTimeout = undefined;
		}

		// Free large in-memory structures
		this.allActivities.length = 0;
		this.visitedCells.clear();
		this.processedActivityIds.clear();

		// Ask worker to drop big state, then terminate
		try {
			this.worker?.postMessage({ type: "clear" });
		} catch (e) {
			// ignore errors while posting message during unload
		}
		this.worker?.terminate();
		this.worker = undefined;

		this.cityManager?.terminate();
		this.cityManager = undefined;

		if (this.cityOutlineAnimationFrame) {
			cancelAnimationFrame(this.cityOutlineAnimationFrame);
			this.cityOutlineAnimationFrame = undefined;
		}

		this.routeLayer?.remove();
		this.routeLayer = undefined;

		// Force GL context loss so textures are freed quickly
		if (this.map) {
			try {
				const canvas = this.map.getCanvas() as HTMLCanvasElement | null;
				const gl = (canvas?.getContext("webgl2") || canvas?.getContext("webgl")) as any;
				gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
			} catch (e) {
				// ignore
			}
			this.map.remove();
			this.map = undefined;
		}

		this.controls?.destroy();
		this.controls = undefined;

		this.sidebar?.destroy();
		this.sidebar = undefined;
	}
}

// Initialization
let app: ExplorationMapApp;

// @ts-ignore
if (import.meta.hot) {
	// @ts-ignore
	import.meta.hot.dispose(() => app?.destroy());
}

// ensure cleanup on full reloads
window.addEventListener("beforeunload", () => app?.destroy());
window.addEventListener("unload", () => app?.destroy());

const init = async () => {
	if (app) app.destroy();
	app = new ExplorationMapApp();
	try {
		await app.initialize();
	} catch (e) {
		console.error("Init failed:", e);
		alert(`Failed to initialize application: ${e instanceof Error ? e.message : String(e)}`);
	}
};

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
