import type { StravaActivity } from "../../types";
import type { Feature, Polygon, MultiPolygon } from "geojson";

// Export interfaces used by other modules (e.g. stats.ts)
export interface City {
	id: string;
	name: string;
	displayName: string;
	country: string;
	region?: string;
	boundary: Feature<Polygon | MultiPolygon>;
	gridCells: Set<string>; // All cells in polygon
	roadCells: Set<string> | null; // Road-only cells (async computed)
	source: "nominatim";
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	source: "nominatim";
}

// Worker Message Types (Internal)
type CityProcessorResponse =
	| {
			type: "PROGRESS";
			payload: { processed: number; total: number };
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
	  };

export class CityManager {
	private worker: Worker;
	private visitedCells: Set<string>;
	private cellSize: number;
	private latestStats: CityStats[] = [];
	private discoveryProgress = { processed: 0, total: 0 };
	private onProgressCallback?: (processed: number, total: number) => void;
	private discoveryPromiseResolve?: (stats: CityStats[]) => void;
	private viewportStatsResolve?: (percentage: number) => void;

	constructor(visitedCells: Set<string>, cellSize: number) {
		this.visitedCells = visitedCells;
		this.cellSize = cellSize;

		// Initialize the worker
		this.worker = new Worker("/worker/city-processor.js", {
			type: "module",
		});

		this.worker.onmessage = (event: MessageEvent<CityProcessorResponse>) => {
			const { type, payload } = event.data;

			switch (type) {
				case "PROGRESS":
					this.discoveryProgress = { processed: payload.processed, total: payload.total };
					this.onProgressCallback?.(payload.processed, payload.total);
					this.notifyDiscoveryProgress(payload.processed, payload.total);
					break;
				case "STATS_UPDATE":
					this.latestStats = payload.stats;
					// Notify UI of incremental updates (re-using complete event for list refresh)
					this.notifyDiscoveryComplete();
					break;
				case "COMPLETE":
					this.latestStats = payload.stats;
					this.discoveryPromiseResolve?.(payload.stats);
					this.notifyDiscoveryComplete();
					break;
				case "VIEWPORT_STATS":
					this.viewportStatsResolve?.(payload.percentage);
					this.viewportStatsResolve = undefined;
					break;
			}
		};
	}

	public updateVisitedCells(cells: Set<string>) {
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
		onProgress?: (processed: number, total: number) => void,
	): Promise<CityStats[]> {
		this.onProgressCallback = onProgress;
		this.latestStats = [];
		this.discoveryProgress = { processed: 0, total: 0 };

		// Notify start (approximate, worker will refine total)
		this.notifyDiscoveryStart(0);

		return new Promise((resolve) => {
			this.discoveryPromiseResolve = resolve;
			this.worker.postMessage({
				type: "DISCOVER_CITIES",
				payload: {
					activities,
					visitedCells: Array.from(this.visitedCells),
					cellSize: this.cellSize,
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

	public getDiscoveryProgress(): { processed: number; total: number } {
		return this.discoveryProgress;
	}

	public terminate() {
		this.worker.terminate();
	}

	// --- Event Dispatchers ---

	private notifyDiscoveryStart(total: number) {
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("city-discovery-start", { detail: { total } }));
		}
	}

	private notifyDiscoveryProgress(processed: number, total: number) {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-discovery-progress", {
					detail: { processed, total },
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
}
