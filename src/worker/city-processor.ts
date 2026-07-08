import { packCell, unpackCell } from "../lib/projection";
import type { StravaActivity } from "../types";
import { computeCityStats, computeVisitedPercentageForCells } from "../lib/stats";
import { getRoadCellsForBbox } from "../lib/tiles";
import { WorldLookup } from "../lib/geocoding/world-lookup";
import { openDB, type IDBPDatabase, type DBSchema } from "idb";

// IndexedDB schema for city road cells cache
interface CityRoadCellsDB extends DBSchema {
	cityRoadCells: {
		key: string; // osmId
		value: {
			osmId: string;
			roadCells: Int32Array; // interleaved x,y pairs of packed integer cells
			cellSize: number;
			timestamp: number;
		};
	};
}

let roadCellsDb: IDBPDatabase<CityRoadCellsDB> | null = null;
const ROAD_CELLS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function getRoadCellsDb(): Promise<IDBPDatabase<CityRoadCellsDB>> {
	if (roadCellsDb) return roadCellsDb;
	roadCellsDb = await openDB<CityRoadCellsDB>("city-road-cells", 2, {
		upgrade(db, _oldVersion, _newVersion, transaction) {
			if (db.objectStoreNames.contains("cityRoadCells")) {
				transaction.objectStore("cityRoadCells").clear();
			} else {
				db.createObjectStore("cityRoadCells", { keyPath: "osmId" });
			}
		},
	});
	return roadCellsDb;
}

async function getCachedRoadCells(osmId: string, cellSize: number): Promise<Set<number> | null> {
	try {
		const db = await getRoadCellsDb();
		const record = await db.get("cityRoadCells", osmId);
		if (
			record &&
			record.cellSize === cellSize &&
			Date.now() - record.timestamp < ROAD_CELLS_CACHE_MAX_AGE_MS
		) {
			const cells = new Set<number>();
			for (let i = 0; i < record.roadCells.length; i += 2) {
				cells.add(packCell(record.roadCells[i], record.roadCells[i + 1]));
			}
			return cells;
		}
	} catch (e) {
		console.warn("Failed to read road cells from cache:", e);
	}
	return null;
}

async function cacheRoadCells(
	osmId: string,
	roadCells: Set<number>,
	cellSize: number,
): Promise<void> {
	try {
		const db = await getRoadCellsDb();
		const arr = new Int32Array(roadCells.size * 2);
		let i = 0;
		for (const v of roadCells) {
			const { x, y } = unpackCell(v);
			arr[i++] = x;
			arr[i++] = y;
		}
		await db.put("cityRoadCells", {
			osmId,
			roadCells: arr,
			cellSize,
			timestamp: Date.now(),
		});
	} catch (e) {
		console.warn("Failed to cache road cells:", e);
	}
}

type OutlinePolyline = Array<[number, number]>;

// Constants
const DEFAULT_TILES_BASE_URL = "https://tiles.jsinha.com";

export interface City {
	id: string;
	osmId: string;
	name: string;
	displayName: string;
	outline: OutlinePolyline[];
	roadCells: Set<number> | null;
	roadTiles: string;
	shard: string;
	source: "self-hosted";
	center?: { lat: number; lng: number };
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	source: "self-hosted";
	center?: { lat: number; lng: number };
	outline?: OutlinePolyline[];
}

// Worker Message Types
export type CityProcessorMessage =
	| {
			type: "DISCOVER_CITIES";
			payload: {
				activities: StravaActivity[];
				visitedCells: number[];
				cellSize: number;
				tilesBaseUrl?: string;
			};
	  }
	| {
			type: "UPDATE_VISITED_CELLS";
			payload: {
				visitedCells: number[];
			};
	  }
	| {
			type: "CALCULATE_VIEWPORT_STATS";
			payload: {
				bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
				cellSize: number;
			};
	  };

export type CityProcessorResponse =
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
	  };

class CityProcessor {
	private cities = new Map<string, City>();
	private visitedCells = new Set<number>();
	private cellSize = 20;
	private isProcessing = false;
	private pendingDiscoveryActivities: StravaActivity[] | null = null;

	// Discovery progress tracking (two phases: location discovery, then road cell computation)
	private locationTotal = 0;
	private locationProcessed = 0;
	private roadCellTotal = 0;
	private roadCellProcessed = 0;

	private tilesBaseUrl = DEFAULT_TILES_BASE_URL;
	private shardIndex: Map<string, string> = new Map();
	private shardIndexLoaded = false;

	private worldLookup: WorldLookup;

	constructor() {
		this.worldLookup = new WorldLookup(`${this.tilesBaseUrl}/world-lookup.pmtiles`);
	}

	public async handleMessage(event: MessageEvent<CityProcessorMessage>) {
		const { type, payload } = event.data;

		switch (type) {
			case "DISCOVER_CITIES":
				if (payload.tilesBaseUrl) await this.setTilesBaseUrl(payload.tilesBaseUrl);
				this.visitedCells = new Set<number>(payload.visitedCells);
				this.cellSize = payload.cellSize;
				this.discoverCitiesFromActivities(payload.activities);
				break;
			case "UPDATE_VISITED_CELLS":
				this.visitedCells = new Set<number>(payload.visitedCells);
				this.postStats("STATS_UPDATE");
				break;
			case "CALCULATE_VIEWPORT_STATS":
				this.calculateViewportStats(payload.bounds, payload.cellSize);
				break;
		}
	}

	private async loadShardIndex() {
		try {
			const url = `${this.tilesBaseUrl}/city-dataset/city-shard-index.json`;
			const res = await fetch(url);
			if (res.ok) {
				const data = (await res.json()) as Record<string, string>;
				this.shardIndex = new Map(Object.entries(data));
				this.shardIndexLoaded = true;
			}
		} catch (e) {
			console.warn("Failed to load shard index:", e);
		}
	}

	private async setTilesBaseUrl(url?: string) {
		if (!url) return;
		console.log(url);
		const trimmed = url.replace(/\/+$/, "");
		if (trimmed === this.tilesBaseUrl && this.shardIndexLoaded) return;
		this.tilesBaseUrl = trimmed;
		await this.loadShardIndex();
		this.worldLookup = new WorldLookup(`${this.tilesBaseUrl}/world-lookup.pmtiles`);
	}

	private async calculateViewportStats(
		bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
		cellSize: number,
	) {
		try {
			const centerLat = (bounds.minLat + bounds.maxLat) / 2;
			const centerLng = (bounds.minLng + bounds.maxLng) / 2;

			const closestCity = this.findClosestCity(centerLat, centerLng);
			let roadTilesFile: string;

			if (closestCity) {
				roadTilesFile = closestCity.roadTiles;
			} else {
				const lookupResult = await this.worldLookup.query(centerLat, centerLng);
				if (!lookupResult || !lookupResult.roadTiles) {
					self.postMessage({
						type: "VIEWPORT_STATS",
						payload: { percentage: 0 },
					});
					return;
				}
				roadTilesFile = lookupResult.roadTiles;
			}

			const { PMTiles } = await import("pmtiles");
			const base = this.tilesBaseUrl || DEFAULT_TILES_BASE_URL;
			const pmtiles = new PMTiles(`${base}/${roadTilesFile}`);

			const roadCells = await getRoadCellsForBbox(
				bounds.minLat,
				bounds.maxLat,
				bounds.minLng,
				bounds.maxLng,
				cellSize,
				14,
				true,
				pmtiles,
			);

			const percentage = computeVisitedPercentageForCells(roadCells, this.visitedCells);

			self.postMessage({
				type: "VIEWPORT_STATS",
				payload: { percentage },
			});
		} catch (e) {
			console.warn("Failed to calculate viewport stats in worker:", e);
			self.postMessage({
				type: "VIEWPORT_STATS",
				payload: { percentage: 0 },
			});
		}
	}

	private findClosestCity(lat: number, lng: number): City | null {
		let closest: City | null = null;
		let minDist = Infinity;

		for (const city of this.cities.values()) {
			if (!city.center) continue;
			const dLat = city.center.lat - lat;
			const dLng = city.center.lng - lng;
			const dist = dLat * dLat + dLng * dLng;
			if (dist < minDist) {
				minDist = dist;
				closest = city;
			}
		}
		return closest;
	}

	private async discoverCitiesFromActivities(activities: StravaActivity[]) {
		if (this.isProcessing) {
			this.pendingDiscoveryActivities = activities;
			return;
		}
		this.isProcessing = true;

		this.locationTotal = 0;
		this.locationProcessed = 0;
		this.roadCellTotal = 0;
		this.roadCellProcessed = 0;

		try {
			const uniqueLocations = this.groupActivitiesByLocation(activities);
			this.locationTotal = uniqueLocations.length;

			this.postProgress();

			const BATCH_SIZE = 10;
			for (let i = 0; i < uniqueLocations.length; i += BATCH_SIZE) {
				const batch = uniqueLocations.slice(i, i + BATCH_SIZE);
				await Promise.all(batch.map(([lat, lng]) => this.identifyCity(lat, lng)));
				this.locationProcessed = Math.min(i + BATCH_SIZE, uniqueLocations.length);
				this.postProgress();
			}

			this.postStats("COMPLETE");
		} catch (e) {
			console.error("City discovery failed in worker:", e);
			self.postMessage({ type: "ERROR", payload: { message: String(e) } });
		} finally {
			this.isProcessing = false;
			if (this.pendingDiscoveryActivities) {
				const pending = this.pendingDiscoveryActivities;
				this.pendingDiscoveryActivities = null;
				this.discoverCitiesFromActivities(pending);
			}
		}
	}

	private groupActivitiesByLocation(activities: StravaActivity[]): Array<[number, number]> {
		const locations = new Map<string, [number, number]>();
		for (const activity of activities) {
			if (!activity.start_latlng || activity.start_latlng.length < 2) continue;
			const [lat, lng] = activity.start_latlng;
			const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
			if (!locations.has(key)) {
				locations.set(key, [lat, lng]);
			}
		}
		return Array.from(locations.values());
	}

	private async identifyCity(lat: number, lng: number) {
		try {
			const result = await this.worldLookup.query(lat, lng);
			if (!result || !result.osmId || !result.name) return;

			const cityId = result.osmId;
			if (this.cities.has(cityId)) return;

			const shard = this.shardIndex.get(cityId);
			if (!shard) return;

			const base = this.tilesBaseUrl || DEFAULT_TILES_BASE_URL;

			let roadCells: Set<number>;
			const cachedCells = await getCachedRoadCells(cityId, this.cellSize);
			if (cachedCells) {
				roadCells = cachedCells;
			} else {
				const binUrl = `${base}/city-dataset/city-road-cells/${shard}/${cityId}.bin`;
				const res = await fetch(binUrl);
				if (!res.ok) return;
				const buf = await res.arrayBuffer();
				const ints = new Int32Array(buf);
				roadCells = new Set<number>();
				for (let i = 0; i < ints.length; i += 2) {
					roadCells.add(packCell(ints[i], ints[i + 1]));
				}
				cacheRoadCells(cityId, roadCells, this.cellSize).catch(console.warn);
			}

			let outline: OutlinePolyline[] = [];
			try {
				const outlineUrl = `${base}/city-dataset/outlines/${cityId}.json`;
				const outlineRes = await fetch(outlineUrl);
				if (outlineRes.ok) {
					const data = await outlineRes.json();
					outline = data.outlines || [];
				}
			} catch {}

			const city: City = {
				id: cityId,
				osmId: cityId,
				name: result.name,
				displayName: result.name,
				outline,
				roadCells,
				roadTiles: result.roadTiles,
				shard,
				source: "self-hosted",
				center: { lat, lng },
			};

			this.cities.set(cityId, city);
			this.roadCellTotal++;
			this.roadCellProcessed++;
			this.postProgress();
			this.postStats("STATS_UPDATE");
		} catch (e) {
			console.warn("City identification failed:", e);
		}
	}

	private postProgress() {
		// Combine both phases into a single progress percentage
		// Phase 1: location discovery (weight: 30%)
		// Phase 2: road cell computation (weight: 70%)
		const locationWeight = 0.3;
		const roadCellWeight = 0.7;

		const locationProgress =
			this.locationTotal > 0 ? (this.locationProcessed / this.locationTotal) * locationWeight : 0;
		const roadCellProgress =
			this.roadCellTotal > 0 ? (this.roadCellProcessed / this.roadCellTotal) * roadCellWeight : 0;

		const percentage = (locationProgress + roadCellProgress) * 100;

		self.postMessage({
			type: "PROGRESS",
			payload: { percentage },
		});
	}

	private postStats(type: "COMPLETE" | "STATS_UPDATE") {
		const stats = computeCityStats(this.cities.values(), this.visitedCells);
		self.postMessage({
			type,
			payload: { stats },
		});
	}
}

const processor = new CityProcessor();
self.onmessage = (e) => processor.handleMessage(e);
