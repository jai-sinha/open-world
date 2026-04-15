import {
	createContext,
	useContext,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type {
	StravaActivity,
	ProcessingConfig,
	WorkerMessage,
	WorkerResponse,
	PrivacySettings,
} from "@/types";
import { createStravaClient, StravaClient } from "@/lib/strava";
import { loadState, saveState, clearState } from "@/lib/storage";
import { createExplorationLayer, ExplorationCanvasLayer } from "@/lib/canvas-layer";
import { createRouteOverlay, RouteOverlayLayer } from "@/lib/route-layer";
import { CityManager, type CityStats } from "@/lib/geocoding/city-manager";
import { setRoadPMTilesURL } from "@/lib/tiles";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type MessageType = "info" | "success" | "warning" | "error";

export interface AppMessage {
	id: string;
	text: string;
	type: MessageType;
}

export interface ProgressInfo {
	current: number;
	total: number;
	message?: string;
}

export interface StatsInfo {
	cells: number;
	activities: number;
	distance: number;
	area: number;
	viewportExplored: number;
}

interface RouteStyleOptions {
	lineWidth?: number;
	lineOpacity?: number;
	colorByType?: boolean;
}

// ────────────────────────────────────────────────────────────
// Default config
// ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ProcessingConfig = {
	cellSize: 50,
	samplingStep: 25,
	privacyDistance: 0,
	snapToGrid: false,
	skipPrivate: false,
};

const DEFAULT_BATCH_SIZE = 20;

export const MAP_CONFIG = {
	defaultCenter: [11.582, 48.1351] as [number, number],
	defaultZoom: 12,
	style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
};

// ────────────────────────────────────────────────────────────
// Context shape
// ────────────────────────────────────────────────────────────

interface AppContextValue {
	/* ─── state ─── */
	isAuthenticated: boolean;
	athlete: { firstname?: string; lastname?: string } | null;
	allActivities: StravaActivity[];
	isProcessing: boolean;
	progress: ProgressInfo | null;
	config: ProcessingConfig;
	imperialUnits: boolean;
	routeVisible: boolean;
	stats: StatsInfo;
	cityStats: CityStats[];
	cityDiscoveryProgress: number;
	messages: AppMessage[];
	selectedActivities: any[];
	sidebarOpen: boolean;

	/* ─── actions ─── */
	initialize: () => Promise<void>;
	onMapReady: (map: MapLibreMap) => void;
	authorize: () => void;
	logout: () => void;
	fetchAndProcessActivities: () => Promise<void>;
	updatePrivacySettings: (settings: PrivacySettings) => void;
	updateConfig: (config: Partial<ProcessingConfig>) => void;
	setImperialUnits: (v: boolean) => void;
	setRouteVisible: (v: boolean) => void;
	setRouteStyle: (style: RouteStyleOptions) => void;
	setFromDate: (date: Date | null) => void;
	setToDate: (date: Date | null) => void;
	showMessage: (text: string, type: MessageType) => void;
	openSidebar: (activities: any[]) => void;
	closeSidebar: () => void;
	jumpToLocation: (center: [number, number]) => void;
	jumpToCity: (payload: { center: [number, number]; outline?: [number, number][][] }) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

// ────────────────────────────────────────────────────────────
// Hook
// ────────────────────────────────────────────────────────────

export function useApp(): AppContextValue {
	const ctx = useContext(AppContext);
	if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
	return ctx;
}

// ────────────────────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
	/* ─── state ─── */
	const [isAuthenticated, setIsAuthenticated] = useState(false);
	const [athlete, setAthlete] = useState<{
		firstname?: string;
		lastname?: string;
	} | null>(null);
	const [allActivities, setAllActivities] = useState<StravaActivity[]>([]);
	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState<ProgressInfo | null>(null);
	const [config, setConfig] = useState<ProcessingConfig>(DEFAULT_CONFIG);
	const [imperialUnits, setImperialUnitsState] = useState(false);
	const [routeVisible, setRouteVisibleState] = useState(true);
	const [stats, setStats] = useState<StatsInfo>({
		cells: 0,
		activities: 0,
		distance: 0,
		area: 0,
		viewportExplored: 0,
	});
	const [cityStats, setCityStats] = useState<CityStats[]>([]);
	const [cityDiscoveryProgress, setCityDiscoveryProgress] = useState(0);
	const [messages, setMessages] = useState<AppMessage[]>([]);
	const [selectedActivities, setSelectedActivities] = useState<any[]>([]);
	const [sidebarOpen, setSidebarOpen] = useState(false);

	/* ─── refs ─── */
	const mapRef = useRef<MapLibreMap | null>(null);
	const stravaClientRef = useRef<StravaClient | null>(null);
	const workerRef = useRef<Worker | null>(null);
	const explorationLayerRef = useRef<ExplorationCanvasLayer | null>(null);
	const routeLayerRef = useRef<RouteOverlayLayer | null>(null);
	const cityManagerRef = useRef<CityManager | null>(null);
	const visitedCellsRef = useRef<Set<number>>(new Set());
	const processedActivityIdsRef = useRef<Set<number>>(new Set());
	const configRef = useRef<ProcessingConfig>(DEFAULT_CONFIG);
	const tilesBaseUrlRef = useRef<string>("");
	const saveTimeoutRef = useRef<number | undefined>(undefined);
	const statsDebounceTimerRef = useRef<number | undefined>(undefined);
	const cityOutlineAnimationFrameRef = useRef<number | undefined>(undefined);
	const allActivitiesRef = useRef<StravaActivity[]>([]);
	const isProcessingRef = useRef(false);
	const initializedRef = useRef(false);
	const stravaClientIdRef = useRef<string>("");
	const handleWorkerMessageRef = useRef<(response: WorkerResponse) => void>(() => {});

	const CITY_OUTLINE_SOURCE_ID = "city-outline-highlight";
	const CITY_OUTLINE_LAYER_ID = "city-outline-highlight-layer";

	// Keep refs in sync with state
	useEffect(() => {
		configRef.current = config;
	}, [config]);

	useEffect(() => {
		allActivitiesRef.current = allActivities;
	}, [allActivities]);

	useEffect(() => {
		isProcessingRef.current = isProcessing;
	}, [isProcessing]);

	// ──────────────────────────────────────────────────────────
	// Helpers
	// ──────────────────────────────────────────────────────────

	const addMessage = useCallback((text: string, type: MessageType) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		setMessages((prev) => [...prev.slice(-4), { id, text, type }]);
		window.setTimeout(() => {
			setMessages((prev) => prev.filter((m) => m.id !== id));
		}, 3000);
	}, []);

	const sendWorkerMessage = useCallback((message: WorkerMessage) => {
		workerRef.current?.postMessage(message);
	}, []);

	// ──────────────────────────────────────────────────────────
	// Stats
	// ──────────────────────────────────────────────────────────

	const calculateViewportStats = useCallback(async (): Promise<number> => {
		const map = mapRef.current;
		const cm = cityManagerRef.current;
		if (!map || !cm) return 0;
		if (map.getZoom() < 11) return -1;

		const bounds = map.getBounds();
		const ne = bounds.getNorthEast();
		const sw = bounds.getSouthWest();

		// Race the city-worker call against a timeout so a broken worker
		// doesn't hang updateStatsUI (and therefore setStats) forever.
		const VIEWPORT_STATS_TIMEOUT_MS = 10000;
		try {
			return await Promise.race([
				cm.calculateViewportStats({
					minLat: sw.lat,
					maxLat: ne.lat,
					minLng: sw.lng,
					maxLng: ne.lng,
				}),
				new Promise<number>((_, reject) =>
					setTimeout(() => reject(new Error("viewport stats timeout")), VIEWPORT_STATS_TIMEOUT_MS),
				),
			]);
		} catch {
			// City worker unresponsive – return 0 so the rest of the stats still render
			return 0;
		}
	}, []);

	const updateStatsUI = useCallback(
		async (cellCount?: number) => {
			const cells = cellCount ?? visitedCellsRef.current.size;
			const viewportStats = await calculateViewportStats();
			const activities = allActivitiesRef.current;

			const totalDistanceKm = activities.reduce((sum, a) => sum + (a.distance || 0) / 1000, 0);

			setStats({
				cells,
				activities: processedActivityIdsRef.current.size,
				distance: totalDistanceKm,
				area: (cells * Math.pow(configRef.current.cellSize, 2)) / 1_000_000,
				viewportExplored: viewportStats,
			});
		},
		[calculateViewportStats],
	);

	// ──────────────────────────────────────────────────────────
	// Persistence
	// ──────────────────────────────────────────────────────────

	const saveCurrentState = useCallback(async () => {
		try {
			await saveState(
				visitedCellsRef.current,
				processedActivityIdsRef.current,
				configRef.current,
				allActivitiesRef.current,
			);
		} catch (error) {
			console.error("Failed to save state:", error);
		}
	}, []);

	const saveStatePeriodically = useCallback(() => {
		if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
		saveTimeoutRef.current = window.setTimeout(() => saveCurrentState(), 2000);
	}, [saveCurrentState]);

	// ──────────────────────────────────────────────────────────
	// Map & state update (from worker responses)
	// ──────────────────────────────────────────────────────────

	const updateMapAndState = useCallback(
		(data: any) => {
			if (data.visitedCells) {
				visitedCellsRef.current = new Set<number>(data.visitedCells);
				cityManagerRef.current?.updateVisitedCells(visitedCellsRef.current);
			}
			if (data.processedActivityIds) {
				processedActivityIdsRef.current = new Set(data.processedActivityIds);
			}
			if (data.rectangles && explorationLayerRef.current) {
				explorationLayerRef.current.setRectangles(data.rectangles);
			}
			const cellCount = data.totalCells ?? visitedCellsRef.current.size;
			updateStatsUI(cellCount);
		},
		[updateStatsUI],
	);

	// ──────────────────────────────────────────────────────────
	// Worker message handler
	// ──────────────────────────────────────────────────────────

	const handleWorkerMessage = useCallback(
		(response: WorkerResponse) => {
			const { type, data, progress: prog, total } = response;

			switch (type) {
				case "progress":
					if (data?.message) addMessage(data.message, "info");
					if (prog !== undefined && total !== undefined) {
						setProgress({ current: prog, total, message: data?.message });
					}

					// Handle config updates requiring reprocessing
					if (data?.configUpdated && data?.needsReprocess) {
						if (data.noActivities) {
							if (allActivitiesRef.current.length > 0) {
								addMessage("Seeding worker for reprocess...", "info");
								sendWorkerMessage({
									type: "init",
									data: { activities: allActivitiesRef.current },
								});
								sendWorkerMessage({
									type: "updateConfig",
									data: configRef.current,
								});
							} else {
								addMessage("No activities to reprocess. Fetch first.", "warning");
							}
						} else if (!data.queued) {
							setIsProcessing(true);
							addMessage("Reprocessing...", "info");
						}
					}
					break;

				case "rectangles":
					if (data) {
						if (data.reprocessing) {
							setIsProcessing(true);
						}
						updateMapAndState(data);
						if (prog !== undefined && total !== undefined) {
							setProgress({ current: prog, total });
						}
						saveStatePeriodically();
					}
					break;

				case "complete":
					setIsProcessing(false);
					setProgress(null);
					if (data) updateMapAndState(data);
					addMessage("Processing complete!", "success");
					saveCurrentState();
					break;

				case "error":
					setIsProcessing(false);
					setProgress(null);
					addMessage(`Error: ${data?.message}`, "error");
					break;
			}
		},
		[addMessage, updateMapAndState, saveStatePeriodically, saveCurrentState, sendWorkerMessage],
	);

	// Keep handleWorkerMessage ref in sync so the worker's onmessage
	// closure always invokes the latest version (avoids stale closures).
	useEffect(() => {
		handleWorkerMessageRef.current = handleWorkerMessage;
	}, [handleWorkerMessage]);

	// ──────────────────────────────────────────────────────────
	// City outline flash
	// ──────────────────────────────────────────────────────────

	const flashCityOutline = useCallback((outline: [number, number][][]) => {
		const map = mapRef.current;
		if (!map) return;

		if (cityOutlineAnimationFrameRef.current) {
			cancelAnimationFrame(cityOutlineAnimationFrameRef.current);
			cityOutlineAnimationFrameRef.current = undefined;
		}

		const source = map.getSource(CITY_OUTLINE_SOURCE_ID) as GeoJSONSource | undefined;
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
			if (!mapRef.current) return;

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
				mapRef.current.setPaintProperty(CITY_OUTLINE_LAYER_ID, "line-opacity", 0);
				source.setData({ type: "FeatureCollection", features: [] });
				cityOutlineAnimationFrameRef.current = undefined;
				return;
			}

			mapRef.current.setPaintProperty(CITY_OUTLINE_LAYER_ID, "line-opacity", opacity);
			cityOutlineAnimationFrameRef.current = requestAnimationFrame(animate);
		};

		cityOutlineAnimationFrameRef.current = requestAnimationFrame(animate);
	}, []);

	// ──────────────────────────────────────────────────────────
	// Auth helpers
	// ──────────────────────────────────────────────────────────

	const updateAuthUI = useCallback(() => {
		const client = stravaClientRef.current;
		if (client?.isAuthenticated()) {
			setIsAuthenticated(true);
			const a = client.getAthlete();
			setAthlete(a ? { firstname: a.firstname, lastname: a.lastname } : null);
		} else {
			setIsAuthenticated(false);
			setAthlete(null);
		}
	}, []);

	// ──────────────────────────────────────────────────────────
	// Actions
	// ──────────────────────────────────────────────────────────

	const initialize = useCallback(async () => {
		if (initializedRef.current) return;
		initializedRef.current = true;

		try {
			// Fetch server config
			const res = await fetch("/api/config");
			const serverConfig = await res.json();
			stravaClientIdRef.current = serverConfig.STRAVA_CLIENT_ID;
			const tilesUrl = serverConfig.TILES_BASE_URL || serverConfig.ROAD_PM_TILES_URL;
			tilesBaseUrlRef.current = tilesUrl || "";
			if (tilesUrl) setRoadPMTilesURL(tilesUrl);

			// Create strava client
			stravaClientRef.current = createStravaClient({
				clientId: stravaClientIdRef.current,
				redirectUri: window.location.origin + "",
				useLocalServer: true,
			});

			updateAuthUI();
		} catch (error) {
			console.error("Failed to initialize:", error);
			addMessage("Failed to load configuration", "error");
		}
	}, [updateAuthUI, addMessage]);

	const onMapReady = useCallback(
		(map: MapLibreMap) => {
			mapRef.current = map;

			// Exploration layer
			explorationLayerRef.current = createExplorationLayer(map, {
				id: "exploration-layer",
				cellSize: configRef.current.cellSize,
				fillColor: "#4CAF50",
				fillOpacity: 0.3,
				borderWidth: 0,
			});

			// Route layer
			routeLayerRef.current = createRouteOverlay(map, {
				lineColor: "#FF5722",
				lineWidth: 4.5,
				lineOpacity: 0.5,
				showPrivate: !configRef.current.skipPrivate,
				privacyDistance: configRef.current.privacyDistance,
				onRouteClick: (features: any[]) => {
					setSelectedActivities(features);
					setSidebarOpen(true);
				},
			});

			// City outline source + layer
			map.addSource(CITY_OUTLINE_SOURCE_ID, {
				type: "geojson",
				data: { type: "FeatureCollection", features: [] },
			});

			map.addLayer({
				id: CITY_OUTLINE_LAYER_ID,
				type: "line",
				source: CITY_OUTLINE_SOURCE_ID,
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

			// moveend -> debounced stats
			map.on("moveend", () => {
				if (statsDebounceTimerRef.current) clearTimeout(statsDebounceTimerRef.current);
				statsDebounceTimerRef.current = window.setTimeout(() => updateStatsUI(), 250);
			});

			// Worker (Vite module worker)
			const worker = new Worker(new URL("../worker/processor.ts", import.meta.url), {
				type: "module",
			});
			workerRef.current = worker;
			// Use the ref so we always call the latest handleWorkerMessage
			worker.onmessage = (event) => handleWorkerMessageRef.current(event.data);
			worker.onerror = (error) => {
				console.error("Worker error:", error);
				addMessage("Processing error occurred", "error");
				setIsProcessing(false);
			};

			// City worker – also loaded via Vite so its imports are properly bundled
			const cityWorker = new Worker(new URL("../worker/city-processor.ts", import.meta.url), {
				type: "module",
			});
			cityWorker.onerror = (error) => {
				console.error("City worker error:", error);
				addMessage("City worker error occurred", "error");
			};

			// City manager (pass the Vite-bundled worker)
			cityManagerRef.current = new CityManager(
				visitedCellsRef.current,
				configRef.current.cellSize,
				tilesBaseUrlRef.current || undefined,
				cityWorker,
			);
			console.debug(
				"[app] CityManager created, tilesBaseUrl:",
				tilesBaseUrlRef.current || "(default)",
			);

			// Load saved state
			(async () => {
				try {
					const state = await loadState();
					if (state) {
						visitedCellsRef.current = state.visitedCells;
						processedActivityIdsRef.current = state.processedActivityIds;

						const restoredConfig = state.config;
						configRef.current = restoredConfig;
						setConfig(restoredConfig);

						allActivitiesRef.current = state.activities;
						setAllActivities(state.activities);

						// Restore route layer
						routeLayerRef.current?.setActivities(state.activities);
						routeLayerRef.current?.setStyle({
							showPrivate: !restoredConfig.skipPrivate,
						});
						routeLayerRef.current?.setPrivacyDistance(restoredConfig.privacyDistance);

						// Sync worker
						sendWorkerMessage({
							type: "init",
							data: {
								visitedCells: Array.from(visitedCellsRef.current),
								processedActivityIds: Array.from(processedActivityIdsRef.current),
								config: restoredConfig,
								activities: state.activities,
							},
						});

						cityManagerRef.current?.updateVisitedCells(visitedCellsRef.current);
						if (state.activities.length > 0) {
							console.debug(
								"[app] Starting city discovery from IDB restore, activities:",
								state.activities.length,
							);
							cityManagerRef.current?.discoverCitiesFromActivities(state.activities);
						}

						// Request initial rectangles render
						if (explorationLayerRef.current) {
							sendWorkerMessage({
								type: "process",
								data: { activities: [] },
							});
						}

						updateStatsUI();
						addMessage(`Loaded ${visitedCellsRef.current.size} cells from cache`, "success");
					}
				} catch (error) {
					console.error("Failed to load saved state:", error);
				}

				// Handle auth callback (URL params)
				handleAuthCallbackInner();
			})();
		},
		[addMessage, sendWorkerMessage, updateStatsUI],
	);

	const handleAuthCallbackInner = useCallback(async () => {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("code");
		const error = params.get("error");

		if (error) {
			addMessage(`Authentication failed: ${error}`, "error");
			return;
		}

		if (code && stravaClientRef.current) {
			try {
				const success = await stravaClientRef.current.handleCallback(code);
				if (success) {
					addMessage("Successfully authenticated!", "success");
					updateAuthUI();
					window.history.replaceState({}, document.title, window.location.pathname);
					// Auto-fetch after auth
					fetchAndProcessInner();
				} else {
					addMessage("Authentication failed", "error");
				}
			} catch (e) {
				console.error("Auth error:", e);
				addMessage("Authentication error", "error");
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [addMessage, updateAuthUI]);

	const authorize = useCallback(() => {
		stravaClientRef.current?.authorize(["activity:read_all"]);
	}, []);

	const logout = useCallback(() => {
		stravaClientRef.current?.logout();
		setIsAuthenticated(false);
		setAthlete(null);
		clearState();
		addMessage("Logged out", "info");
	}, [addMessage]);

	const fetchAndProcessInner = useCallback(async () => {
		const client = stravaClientRef.current;
		if (!client?.isAuthenticated()) return;
		if (isProcessingRef.current) return;

		try {
			setIsProcessing(true);
			addMessage("Fetching activities...", "info");

			const activities = await client.fetchAllActivities((count) => {
				setProgress({ current: count, total: count, message: `Fetching... ${count}` });
			});

			addMessage(`Fetched ${activities.length} activities`, "success");

			allActivitiesRef.current = activities;
			setAllActivities(activities);

			routeLayerRef.current?.setActivities(activities);

			// Jump to first valid location (best-effort, don't block processing)
			let lat: number | undefined;
			let lng: number | undefined;

			for (const activity of activities) {
				const coords = activity.start_latlng as [number, number] | null | undefined;
				if (!coords || coords.length < 2) continue;
				const [candidateLat, candidateLng] = coords;
				if (
					typeof candidateLat === "number" &&
					typeof candidateLng === "number" &&
					!Number.isNaN(candidateLat) &&
					!Number.isNaN(candidateLng) &&
					candidateLat !== 0 &&
					candidateLng !== 0
				) {
					lat = candidateLat;
					lng = candidateLng;
					break;
				}
			}

			if (lat !== undefined && lng !== undefined) {
				mapRef.current?.jumpTo({ center: [lng, lat], zoom: 12 });
			} else {
				console.warn("No activity with valid location data found — skipping jumpTo");
			}

			console.debug("[app] Starting city discovery from fetch, activities:", activities.length);
			cityManagerRef.current?.discoverCitiesFromActivities(activities);

			// Sync worker with full list
			sendWorkerMessage({ type: "init", data: { activities } });
			await saveCurrentState();

			const newActivities = activities.filter((a) => !processedActivityIdsRef.current.has(a.id));
			if (newActivities.length === 0) {
				addMessage("No new activities to process", "info");
				setIsProcessing(false);
				setProgress(null);
				return;
			}

			addMessage(`Processing ${newActivities.length} new activities...`, "info");

			sendWorkerMessage({
				type: "process",
				data: { activities: newActivities, batchSize: DEFAULT_BATCH_SIZE },
			});
		} catch (error) {
			console.error("Fetch error:", error);
			addMessage("Failed to fetch activities", "error");
			setIsProcessing(false);
			setProgress(null);
		}
	}, [addMessage, sendWorkerMessage, saveCurrentState]);

	const fetchAndProcessActivities = useCallback(async () => {
		await fetchAndProcessInner();
	}, [fetchAndProcessInner]);

	const updatePrivacySettingsAction = useCallback((settings: PrivacySettings) => {
		const enabled = settings.enabled;
		const skipPrivate = settings.skipPrivateActivities;

		const newConfig: ProcessingConfig = {
			...configRef.current,
			privacyDistance: enabled ? settings.removeDistance || 400 : 0,
			snapToGrid: settings.snapToGrid,
			skipPrivate,
		};

		configRef.current = newConfig;
		setConfig(newConfig);

		routeLayerRef.current?.setStyle({
			showPrivate: !newConfig.skipPrivate,
		});
		routeLayerRef.current?.setPrivacyDistance(newConfig.privacyDistance);
	}, []);

	const updateConfigAction = useCallback(
		(partial: Partial<ProcessingConfig>) => {
			const newConfig = { ...configRef.current, ...partial };
			configRef.current = newConfig;
			setConfig(newConfig);

			if (partial.cellSize && explorationLayerRef.current) {
				explorationLayerRef.current.setCellSize(partial.cellSize);
				cityManagerRef.current = new CityManager(
					visitedCellsRef.current,
					newConfig.cellSize,
					tilesBaseUrlRef.current || undefined,
				);
				if (allActivitiesRef.current.length > 0) {
					cityManagerRef.current.discoverCitiesFromActivities(allActivitiesRef.current);
				}
			}

			sendWorkerMessage({ type: "updateConfig", data: newConfig });
		},
		[sendWorkerMessage],
	);

	const setImperialUnitsAction = useCallback((v: boolean) => {
		setImperialUnitsState(v);
		routeLayerRef.current?.setUnits(v);
	}, []);

	const setRouteVisibleAction = useCallback((v: boolean) => {
		setRouteVisibleState(v);
		routeLayerRef.current?.setVisibility(v);
	}, []);

	const setRouteStyleAction = useCallback((style: RouteStyleOptions) => {
		routeLayerRef.current?.setStyle(style);
	}, []);

	const setFromDateAction = useCallback((date: Date | null) => {
		routeLayerRef.current?.setFromDate(date);
	}, []);

	const setToDateAction = useCallback((date: Date | null) => {
		routeLayerRef.current?.setToDate(date);
	}, []);

	const showMessage = useCallback(
		(text: string, type: MessageType) => {
			addMessage(text, type);
		},
		[addMessage],
	);

	const openSidebarAction = useCallback((activities: any[]) => {
		setSelectedActivities(activities);
		setSidebarOpen(true);
	}, []);

	const closeSidebarAction = useCallback(() => {
		setSidebarOpen(false);
		setSelectedActivities([]);
	}, []);

	const jumpToLocation = useCallback((center: [number, number]) => {
		mapRef.current?.jumpTo({ center, zoom: 12 });
	}, []);

	const jumpToCity = useCallback(
		(payload: { center: [number, number]; outline?: [number, number][][] }) => {
			const map = mapRef.current;
			const { center, outline } = payload;

			if (map && outline && outline.length > 0) {
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
					map.fitBounds(
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
					map.jumpTo({ center, zoom: 12 });
				}

				flashCityOutline(outline);
			} else {
				map?.jumpTo({ center, zoom: 12 });
			}
		},
		[flashCityOutline],
	);

	// ──────────────────────────────────────────────────────────
	// City discovery events (window custom events)
	// ──────────────────────────────────────────────────────────

	useEffect(() => {
		const onStart = () => {
			setCityDiscoveryProgress(0);
		};

		const onProgress = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.percentage !== undefined) {
				setCityDiscoveryProgress(detail.percentage);
			}
		};

		const onComplete = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			setCityDiscoveryProgress(100);
			if (detail?.stats) {
				setCityStats(detail.stats);
			}
		};

		const onStatsUpdate = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.stats) {
				setCityStats(detail.stats);
			}
		};

		window.addEventListener("city-discovery-start", onStart);
		window.addEventListener("city-discovery-progress", onProgress);
		window.addEventListener("city-discovery-complete", onComplete);
		window.addEventListener("city-stats-update", onStatsUpdate);

		return () => {
			window.removeEventListener("city-discovery-start", onStart);
			window.removeEventListener("city-discovery-progress", onProgress);
			window.removeEventListener("city-discovery-complete", onComplete);
			window.removeEventListener("city-stats-update", onStatsUpdate);
		};
	}, []);

	// ──────────────────────────────────────────────────────────
	// Cleanup on unmount
	// ──────────────────────────────────────────────────────────

	useEffect(() => {
		return () => {
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
				saveTimeoutRef.current = undefined;
			}
			if (statsDebounceTimerRef.current) {
				clearTimeout(statsDebounceTimerRef.current);
				statsDebounceTimerRef.current = undefined;
			}

			// Free large structures
			allActivitiesRef.current.length = 0;
			visitedCellsRef.current.clear();
			processedActivityIdsRef.current.clear();

			// Worker cleanup
			try {
				workerRef.current?.postMessage({ type: "clear" });
			} catch (_e) {
				// ignore
			}
			workerRef.current?.terminate();
			workerRef.current = null;

			// City manager
			cityManagerRef.current?.terminate();
			cityManagerRef.current = null;

			// Outline animation
			if (cityOutlineAnimationFrameRef.current) {
				cancelAnimationFrame(cityOutlineAnimationFrameRef.current);
				cityOutlineAnimationFrameRef.current = undefined;
			}

			// Route layer
			routeLayerRef.current?.remove();
			routeLayerRef.current = null;

			// Map
			if (mapRef.current) {
				try {
					const canvas = mapRef.current.getCanvas() as HTMLCanvasElement | null;
					const gl = (canvas?.getContext("webgl2") || canvas?.getContext("webgl")) as any;
					gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
				} catch (_e) {
					// ignore
				}
				mapRef.current.remove();
				mapRef.current = null;
			}

			explorationLayerRef.current = null;
			initializedRef.current = false;
		};
	}, []);

	// ──────────────────────────────────────────────────────────
	// Context value (memoized)
	// ──────────────────────────────────────────────────────────

	const value = useMemo<AppContextValue>(
		() => ({
			// state
			isAuthenticated,
			athlete,
			allActivities,
			isProcessing,
			progress,
			config,
			imperialUnits,
			routeVisible,
			stats,
			cityStats,
			cityDiscoveryProgress,
			messages,
			selectedActivities,
			sidebarOpen,
			// actions
			initialize,
			onMapReady,
			authorize,
			logout,
			fetchAndProcessActivities,
			updatePrivacySettings: updatePrivacySettingsAction,
			updateConfig: updateConfigAction,
			setImperialUnits: setImperialUnitsAction,
			setRouteVisible: setRouteVisibleAction,
			setRouteStyle: setRouteStyleAction,
			setFromDate: setFromDateAction,
			setToDate: setToDateAction,
			showMessage,
			openSidebar: openSidebarAction,
			closeSidebar: closeSidebarAction,
			jumpToLocation,
			jumpToCity,
		}),
		[
			isAuthenticated,
			athlete,
			allActivities,
			isProcessing,
			progress,
			config,
			imperialUnits,
			routeVisible,
			stats,
			cityStats,
			cityDiscoveryProgress,
			messages,
			selectedActivities,
			sidebarOpen,
			initialize,
			onMapReady,
			authorize,
			logout,
			fetchAndProcessActivities,
			updatePrivacySettingsAction,
			updateConfigAction,
			setImperialUnitsAction,
			setRouteVisibleAction,
			setRouteStyleAction,
			setFromDateAction,
			setToDateAction,
			showMessage,
			openSidebarAction,
			closeSidebarAction,
			jumpToLocation,
			jumpToCity,
		],
	);

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export default AppContext;
