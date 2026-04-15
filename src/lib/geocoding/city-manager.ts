import type { Feature, Polygon, MultiPolygon } from "geojson";
import type { StravaActivity } from "../../types";

// Export interfaces used by other modules (e.g. stats.ts)
export interface City {
	id: string;
	osmId?: string;
	name: string;
	displayName: string;
	boundary: Feature<Polygon | MultiPolygon>;
	roadCells: Set<number> | null; // Road-only cells (async computed)
	source: "self-hosted" | "nominatim";
	center?: { lat: number; lng: number }; // Cache center for distance lookups
	outline?: [number, number][][]; // Simplified outer boundary rings as [lng, lat] polylines
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	source: "self-hosted" | "nominatim";
	center?: { lat: number; lng: number };
	outline?: [number, number][][]; // Simplified outer boundary rings as [lng, lat] polylines
}

// Worker Message Types (Internal)
type CityProcessorResponse =
	| {
			type: "PROGRESS";
			payload: { percentage: number };
	  }
	| {
			type: "COMPLETE";
			payload: { stats: CityStats[] };
	  }
	| {
			type: "STATS_UPDATE";
			payload: { stats: CityStats[] };
	  }
	| {
			type: "VIEWPORT_STATS";
			payload: { percentage: number };
	  }
	| { type: "ERROR"; payload: { message: string } };

export class CityManager {
	private worker: Worker;
	private visitedCells: Set<number>;
	private cellSize: number;
	private tilesBaseUrl?: string;
	private latestStats: CityStats[] = [];
	private discoveryProgress = 0;
	private onProgressCallback?: (percentage: number) => void;
	private discoveryPromiseResolve?: (stats: CityStats[]) => void;
	private viewportStatsResolve?: (percentage: number) => void;
	private discoveryRunId = 0;
	private activeDiscoveryRunId: number | null = null;

	constructor(visitedCells: Set<number>, cellSize: number, tilesBaseUrl?: string, worker?: Worker) {
		this.visitedCells = visitedCells;
		this.cellSize = cellSize;
		this.tilesBaseUrl = tilesBaseUrl;

		// Use provided worker or fall back to hardcoded URL
		this.worker =
			worker ??
			new Worker("/worker/city-processor.js", {
				type: "module",
			});

		this.worker.onmessage = (event: MessageEvent<CityProcessorResponse>) => {
			const { type, payload } = event.data;

			switch (type) {
				case "PROGRESS":
					if (this.activeDiscoveryRunId === null) break;
					this.discoveryProgress = payload.percentage;
					this.onProgressCallback?.(payload.percentage);
					this.notifyDiscoveryProgress(payload.percentage);
					break;
				case "STATS_UPDATE":
					if (this.activeDiscoveryRunId === null) break;
					this.latestStats = payload.stats;
					// Notify UI of incremental updates (separate event to avoid premature list display)
					this.notifyStatsUpdate();
					break;
				case "COMPLETE":
					if (this.activeDiscoveryRunId === null) break;
					this.latestStats = payload.stats;
					this.discoveryProgress = 100;
					this.activeDiscoveryRunId = null;
					this.onProgressCallback = undefined;
					this.discoveryPromiseResolve?.(payload.stats);
					this.discoveryPromiseResolve = undefined;
					this.notifyDiscoveryComplete();
					break;
				case "VIEWPORT_STATS":
					this.viewportStatsResolve?.(payload.percentage);
					this.viewportStatsResolve = undefined;
					break;
				case "ERROR":
					if (this.activeDiscoveryRunId !== null) {
						this.activeDiscoveryRunId = null;
						this.onProgressCallback = undefined;
						this.discoveryPromiseResolve = undefined;
					}
					console.error("[CityManager] worker error:", payload.message);
					break;
				default:
					console.warn("Unknown city worker message type:", (event.data as any)?.type);
			}
		};
	}

	public updateVisitedCells(cells: Set<number>) {
		this.visitedCells = cells;
		this.worker.postMessage({
			type: "UPDATE_VISITED_CELLS",
			payload: {
				visitedCells: Array.from(cells),
			},
		});
	}

	public async discoverCitiesFromActivities(
		activities: StravaActivity[],
		onProgress?: (percentage: number) => void,
	): Promise<CityStats[]> {
		const runId = ++this.discoveryRunId;
		this.activeDiscoveryRunId = runId;
		this.onProgressCallback = onProgress;
		this.latestStats = [];
		this.discoveryProgress = 0;

		// Notify start (approximate, worker will refine total)
		this.notifyDiscoveryStart(0);

		return new Promise((resolve) => {
			this.discoveryPromiseResolve = (stats) => {
				if (this.activeDiscoveryRunId === null || runId === this.discoveryRunId) {
					resolve(stats);
				}
			};
			this.worker.postMessage({
				type: "DISCOVER_CITIES",
				payload: {
					activities,
					visitedCells: Array.from(this.visitedCells),
					cellSize: this.cellSize,
					tilesBaseUrl: this.tilesBaseUrl,
				},
			});
		});
	}

	public async calculateViewportStats(bounds: {
		minLat: number;
		maxLat: number;
		minLng: number;
		maxLng: number;
	}): Promise<number> {
		return new Promise((resolve) => {
			// Cancel any pending request
			if (this.viewportStatsResolve) {
				this.viewportStatsResolve(0);
			}
			this.viewportStatsResolve = resolve;
			this.worker.postMessage({
				type: "CALCULATE_VIEWPORT_STATS",
				payload: {
					bounds,
					cellSize: this.cellSize,
				},
			});
		});
	}

	public getStats(): CityStats[] {
		return this.latestStats;
	}

	public getDiscoveryProgress(): number {
		return this.discoveryProgress;
	}

	public terminate() {
		this.activeDiscoveryRunId = null;
		this.onProgressCallback = undefined;
		this.discoveryPromiseResolve = undefined;
		this.worker.terminate();
	}

	// --- Event Dispatchers ---

	private notifyDiscoveryStart(total: number) {
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("city-discovery-start", { detail: { total } }));
		}
	}

	private notifyDiscoveryProgress(percentage: number) {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-discovery-progress", {
					detail: { percentage },
				}),
			);
		}
	}

	private notifyDiscoveryComplete() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-discovery-complete", { detail: { stats: this.latestStats } }),
			);
		}
	}

	private notifyStatsUpdate() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-stats-update", { detail: { stats: this.latestStats } }),
			);
		}
	}
}
