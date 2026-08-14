import { packCell, unpackCell } from "../lib/projection";
import type { StravaActivity } from "../types";
import { computeCityStats, computeVisitedPercentageForCells } from "../lib/stats";
import { getRoadCellsForBbox } from "../lib/tiles";
import { WorldLookup } from "../lib/geocoding/world-lookup";

// ─── IndexedDB cache for city road cells ───

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

interface CityRoadCellsDB extends DBSchema {
	cityRoadCells: {
		key: string;
		value: {
			osmId: string;
			roadCells: Int32Array;
			timestamp: number;
		};
	};
}

const ROAD_CELLS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let roadCellsDb: IDBPDatabase<CityRoadCellsDB> | null = null;

async function getRoadCellsDb(): Promise<IDBPDatabase<CityRoadCellsDB>> {
	if (roadCellsDb) return roadCellsDb;
	roadCellsDb = await openDB<CityRoadCellsDB>("city-road-cells", 2, {
		upgrade(db) {
			if (!db.objectStoreNames.contains("cityRoadCells")) {
				db.createObjectStore("cityRoadCells", { keyPath: "osmId" });
			}
		},
	});
	return roadCellsDb;
}

async function getCachedRoadCells(
	osmId: string,
): Promise<Set<number> | null> {
	try {
		const db = await getRoadCellsDb();
		const record = await db.get("cityRoadCells", osmId);
		if (record && Date.now() - record.timestamp < ROAD_CELLS_CACHE_MAX_AGE_MS) {
			const cells = new Set<number>();
			for (let i = 0; i < record.roadCells.length; i += 2) {
				cells.add(packCell(record.roadCells[i], record.roadCells[i + 1]));
			}
			return cells;
		}
	} catch (e) {
		console.warn("Failed to read cached road cells:", e);
	}
	return null;
}

async function cacheRoadCells(
	osmId: string,
	roadCells: Set<number>,
): Promise<void> {
	try {
		const db = await getRoadCellsDb();
		const pairs = new Int32Array(roadCells.size * 2);
		let i = 0;
		for (const v of roadCells) {
			const { x, y } = unpackCell(v);
			pairs[i++] = x;
			pairs[i++] = y;
		}
		await db.put("cityRoadCells", {
			osmId,
			roadCells: pairs,
			timestamp: Date.now(),
		});
	} catch (e) {
		console.warn("Failed to cache road cells:", e);
	}
}

// ─── Types ───

export interface City {
	id: string;
	osmId: string;
	name: string;
	displayName: string;
	outline: [number, number][][];
	roadCells: Set<number> | null;
	roadTiles: string;
	center?: { lat: number; lng: number };
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	center?: { lat: number; lng: number };
	outline?: [number, number][][];
}

export type CityProcessorMessage =
	| {
			type: "DISCOVER_CITIES";
			payload: {
				activities: StravaActivity[];
				visitedCells: number[];
				tilesBaseUrl: string;
			};
	  }
	| {
			type: "UPDATE_VISITED_CELLS";
			payload: { visitedCells: number[] };
	  }
	| {
			type: "CALCULATE_VIEWPORT_STATS";
			payload: {
				bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
			};
	  };

export type CityProcessorResponse =
	| { type: "PROGRESS"; payload: { percentage: number } }
	| { type: "COMPLETE"; payload: { stats: CityStats[] } }
	| { type: "STATS_UPDATE"; payload: { stats: CityStats[] } }
	| { type: "VIEWPORT_STATS"; payload: { percentage: number } };

// ─── CityProcessor ───

class CityProcessor {
	private cities = new Map<string, City>();
	private visitedCells = new Set<number>();
	private isProcessing = false;
	private pendingDiscoveryActivities: StravaActivity[] | null = null;

	private locationTotal = 0;
	private locationProcessed = 0;
	private roadCellTotal = 0;
	private roadCellProcessed = 0;

	private tilesBaseUrl = "";
	private worldLookup: WorldLookup | null = null;
	private shardIndex: Map<string, string> | null = null;

	public async handleMessage(event: MessageEvent<CityProcessorMessage>) {
		const { type, payload } = event.data;

		switch (type) {
			case "DISCOVER_CITIES":
				await this.initTiles(payload.tilesBaseUrl);
				this.visitedCells = new Set<number>(payload.visitedCells);
				this.discoverCitiesFromActivities(payload.activities);
				break;
			case "UPDATE_VISITED_CELLS":
				this.visitedCells = new Set<number>(payload.visitedCells);
				this.postStats("STATS_UPDATE");
				break;
			case "CALCULATE_VIEWPORT_STATS":
				this.calculateViewportStats(payload.bounds);
				break;
		}
	}

	private async initTiles(url: string) {
		const trimmed = url.replace(/\/+$/, "");
		if (trimmed === this.tilesBaseUrl && this.worldLookup) return;
		this.tilesBaseUrl = trimmed;
		this.worldLookup = new WorldLookup(`${this.tilesBaseUrl}/world-lookup.pmtiles`);
		this.shardIndex = null;
		await this.loadShardIndex();
	}

	private async loadShardIndex() {
		try {
			const url = `${this.tilesBaseUrl}/city-dataset/city-shard-index.json`;
			const res = await fetch(url);
			if (res.ok) {
				const data = (await res.json()) as Record<string, string>;
				this.shardIndex = new Map(Object.entries(data));
			}
		} catch (e) {
			console.warn("Failed to load shard index:", e);
		}
	}

	private async calculateViewportStats(
		bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
	) {
		try {
			const centerLat = (bounds.minLat + bounds.maxLat) / 2;
			const centerLng = (bounds.minLng + bounds.maxLng) / 2;

			const closestCity = this.findClosestCity(centerLat, centerLng);
			let roadTilesFile: string;

			if (closestCity) {
				roadTilesFile = closestCity.roadTiles;
			} else {
				const lookupResult = await this.worldLookup?.query(centerLat, centerLng);
				if (!lookupResult || !lookupResult.roadTiles) {
					self.postMessage({ type: "VIEWPORT_STATS", payload: { percentage: 0 } });
					return;
				}
				roadTilesFile = lookupResult.roadTiles;
			}

			const { PMTiles } = await import("pmtiles");
			const pmtiles = new PMTiles(`${this.tilesBaseUrl}/${roadTilesFile}`);

			const roadCells = await getRoadCellsForBbox(
				bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng,
				14, true, pmtiles,
			);

			self.postMessage({
				type: "VIEWPORT_STATS",
				payload: { percentage: computeVisitedPercentageForCells(roadCells, this.visitedCells) },
			});
		} catch (e) {
			console.warn("Failed to calculate viewport stats in worker:", e);
			self.postMessage({ type: "VIEWPORT_STATS", payload: { percentage: 0 } });
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
			if (dist < minDist) { minDist = dist; closest = city; }
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
				const citiesBefore = this.cities.size;
				await Promise.all(batch.map(([lat, lng]) => this.identifyCity(lat, lng)));
				this.locationProcessed = Math.min(i + BATCH_SIZE, uniqueLocations.length);
				this.postProgress();
				if (this.cities.size > citiesBefore) this.postStats("STATS_UPDATE");
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
			if (!locations.has(key)) locations.set(key, [lat, lng]);
		}
		return Array.from(locations.values());
	}

	private async identifyCity(lat: number, lng: number) {
		try {
			if (!this.worldLookup) return;
			const result = await this.worldLookup.query(lat, lng);
			if (!result || !result.osmId || !result.name) return;

			const cityId = result.osmId;
			if (this.cities.has(cityId)) return;

			const base = this.tilesBaseUrl;

			// Fetch pre-computed road cells from city-dataset (.bin files generated
			// by run_city_dataset.sh / city_road_cells_assigner, clipped to exact
			// city boundary polygon).
			let roadCells: Set<number>;
			const cached = await getCachedRoadCells(cityId);
			if (cached) {
				roadCells = cached;
			} else {
				const shard = this.shardIndex?.get(cityId);
				if (shard) {
					const binUrl = `${base}/city-dataset/city-road-cells/${shard}/${cityId}.bin`;
					const res = await fetch(binUrl);
					if (res.ok) {
						const buf = await res.arrayBuffer();
						const ints = new Int32Array(buf);
						roadCells = new Set<number>();
						for (let i = 0; i < ints.length; i += 2) {
							roadCells.add(packCell(ints[i], ints[i + 1]));
						}
						cacheRoadCells(cityId, roadCells).catch(console.warn);
					} else {
						return;
					}
				} else {
					return;
				}
			}

			// Fetch boundary outline from city-dataset
			let outline: [number, number][][] = [];
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
				center: { lat, lng },
			};

			this.cities.set(cityId, city);
			this.roadCellTotal++;
			this.roadCellProcessed++;
			this.postProgress();
		} catch (e) {
			console.warn("City identification failed:", e);
		}
	}

	private postProgress() {
		const locationWeight = 0.3;
		const roadCellWeight = 0.7;
		const locationProgress =
			this.locationTotal > 0 ? (this.locationProcessed / this.locationTotal) * locationWeight : 0;
		const roadCellProgress =
			this.roadCellTotal > 0 ? (this.roadCellProcessed / this.roadCellTotal) * roadCellWeight : 0;
		self.postMessage({
			type: "PROGRESS",
			payload: { percentage: (locationProgress + roadCellProgress) * 100 },
		});
	}

	private postStats(type: "COMPLETE" | "STATS_UPDATE") {
		self.postMessage({
			type,
			payload: { stats: computeCityStats(this.cities.values(), this.visitedCells) },
		});
	}
}

const processor = new CityProcessor();
self.onmessage = (e) => processor.handleMessage(e);
