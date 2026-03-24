import type { Feature, Polygon, MultiPolygon } from "geojson";
import { latLngToMeters, packCell, unpackCell } from "../lib/projection";
import type { StravaActivity } from "../types";
import { computeCityStats, computeVisitedPercentageForCells } from "../lib/stats";
import { getRoadCellsForBbox } from "../lib/tiles";
import { WorldLookup } from "../lib/geocoding/world-lookup";
import type { WorldLookupResult } from "../lib/geocoding/world-lookup";
import { PMTiles } from "pmtiles";
import { openDB, type IDBPDatabase, type DBSchema } from "idb";

// Yield back to the event loop so pending network/IDB callbacks can fire.
// Uses scheduler.yield() (Chrome 129+ in workers) with a setTimeout fallback.
// Using (globalThis as any) to avoid TypeScript lib gaps in WebWorker context.
const _schedulerYield: (() => Promise<void>) | null = (() => {
	try {
		const s = (globalThis as any).scheduler;
		if (s && typeof s.yield === "function") return () => s.yield() as Promise<void>;
	} catch {}
	return null;
})();
const yieldToEventLoop: () => Promise<void> =
	_schedulerYield ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const YIELD_INTERVAL = 10_000; // yield every N cells in tight loops

// IndexedDB schema for city boundary cache
interface CityBoundaryDB extends DBSchema {
	cityBoundaries: {
		key: string; // osmId
		value: {
			osmId: string;
			boundary: Feature<Polygon | MultiPolygon>;
			timestamp: number;
		};
	};
}

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

let boundaryDb: IDBPDatabase<CityBoundaryDB> | null = null;
let roadCellsDb: IDBPDatabase<CityRoadCellsDB> | null = null;
const BOUNDARY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ROAD_CELLS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function getBoundaryDb(): Promise<IDBPDatabase<CityBoundaryDB>> {
	if (boundaryDb) return boundaryDb;
	boundaryDb = await openDB<CityBoundaryDB>("city-boundaries", 1, {
		upgrade(db) {
			if (!db.objectStoreNames.contains("cityBoundaries")) {
				db.createObjectStore("cityBoundaries", { keyPath: "osmId" });
			}
		},
	});
	return boundaryDb;
}

async function getRoadCellsDb(): Promise<IDBPDatabase<CityRoadCellsDB>> {
	if (roadCellsDb) return roadCellsDb;
	roadCellsDb = await openDB<CityRoadCellsDB>("city-road-cells", 2, {
		upgrade(db, _oldVersion, _newVersion, transaction) {
			// Wipe on upgrade — roadCells format changed to Int32Array
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
			console.debug(`[RoadCellCache] HIT for ${osmId}: ${record.roadCells.length / 2} cells`);
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
		console.debug(`[RoadCellCache] STORED ${osmId}: ${roadCells.size} cells`);
	} catch (e) {
		console.warn("Failed to cache road cells:", e);
	}
}

// Calculate appropriate zoom level based on bbox size
// Larger cities use lower zoom to reduce tile count
function getAdaptiveZoom(minLat: number, maxLat: number, minLng: number, maxLng: number): number {
	const latSpan = Math.abs(maxLat - minLat);
	const lngSpan = Math.abs(maxLng - minLng);
	const maxSpan = Math.max(latSpan, lngSpan);

	// Approximate tile counts at different zooms for reference:
	// z14: ~0.02° per tile, z13: ~0.04°, z12: ~0.08°, z11: ~0.16°
	if (maxSpan > 0.5) {
		// Very large city (>50km span) - use z12
		return 12;
	} else if (maxSpan > 0.25) {
		// Large city (25-50km span) - use z13
		return 13;
	} else {
		// Normal city - use z14
		return 14;
	}
}

async function getCachedBoundary(osmId: string): Promise<Feature<Polygon | MultiPolygon> | null> {
	try {
		const db = await getBoundaryDb();
		const record = await db.get("cityBoundaries", osmId);
		if (record && Date.now() - record.timestamp < BOUNDARY_CACHE_MAX_AGE_MS) {
			return record.boundary;
		}
	} catch (e) {
		console.warn("Failed to read boundary from cache:", e);
	}
	return null;
}

async function cacheBoundary(
	osmId: string,
	boundary: Feature<Polygon | MultiPolygon>,
): Promise<void> {
	try {
		const db = await getBoundaryDb();
		await db.put("cityBoundaries", {
			osmId,
			boundary,
			timestamp: Date.now(),
		});
	} catch (e) {
		console.warn("Failed to cache boundary:", e);
	}
}

// ── Inline point-in-polygon (replaces @turf/boolean-point-in-polygon) ────────
// Pre-flatten a GeoJSON ring to Web Mercator meters [mx0, my0, mx1, my1, ...]
// Converting once here means the PIP hot loop never calls metersToLatLng.
// Douglas-Peucker simplification on a Float64Array of interleaved [x,y,...] points.
// Tolerance is in the same units as the coordinates (meters). Operates in-place on
// an index array to avoid allocating new typed arrays for each recursive step.
function dpSimplify(data: Float64Array, tolerance: number): Float64Array {
	const n = data.length >> 1;
	if (n <= 2) return data;
	const tol2 = tolerance * tolerance;
	// Use a stack-based iterative approach to avoid recursion depth limits.
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length > 0) {
		const [start, end] = stack.pop()!;
		if (end - start < 2) continue;
		const x1 = data[start * 2], y1 = data[start * 2 + 1];
		const x2 = data[end * 2],   y2 = data[end * 2 + 1];
		const dx = x2 - x1, dy = y2 - y1;
		const len2 = dx * dx + dy * dy;
		let maxD2 = -1, maxIdx = start;
		for (let i = start + 1; i < end; i++) {
			const px = data[i * 2] - x1, py = data[i * 2 + 1] - y1;
			const d2 = len2 === 0
				? px * px + py * py
				: (() => { const t = (px * dx + py * dy) / len2; const qx = px - t * dx, qy = py - t * dy; return qx * qx + qy * qy; })();
			if (d2 > maxD2) { maxD2 = d2; maxIdx = i; }
		}
		if (maxD2 > tol2) {
			keep[maxIdx] = 1;
			stack.push([start, maxIdx], [maxIdx, end]);
		}
	}
	let count = 0;
	for (let i = 0; i < n; i++) if (keep[i]) count++;
	const out = new Float64Array(count * 2);
	let o = 0;
	for (let i = 0; i < n; i++) if (keep[i]) { out[o++] = data[i * 2]; out[o++] = data[i * 2 + 1]; }
	return out;
}

// Convert a GeoJSON ring ([lng,lat][] pairs) to a FlatRing in Web Mercator meters,
// simplified to `tolerance` metres (half a cell — preserves sub-cell correctness).
function flattenRing(ring: number[][], tolerance: number): FlatRing {
	const raw = new Float64Array(ring.length * 2);
	for (let i = 0; i < ring.length; i++) {
		const { x, y } = latLngToMeters(ring[i][1], ring[i][0]);
		raw[i * 2] = x;
		raw[i * 2 + 1] = y;
	}
	const data = dpSimplify(raw, tolerance);
	const n = data.length >> 1;
	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (let i = 0; i < n; i++) {
		const x = data[i * 2], y = data[i * 2 + 1];
		if (x < minX) minX = x; if (x > maxX) maxX = x;
		if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	return { data, minX, maxX, minY, maxY };
}

// Standard ray-casting test on a FlatRing. Bbox is checked by caller.
function pointInFlatRing(ring: FlatRing, x: number, y: number): boolean {
	const { data } = ring;
	const n = data.length >> 1;
	let inside = false;
	let j = n - 1;
	for (let i = 0; i < n; i++) {
		const xi = data[i * 2];
		const yi = data[i * 2 + 1];
		const xj = data[j * 2];
		const yj = data[j * 2 + 1];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
		j = i;
	}
	return inside;
}

// Check against pre-flattened polygon rings with bbox short-circuit.
function pointInFlatPolygon(outerRings: FlatRing[], holesPerPoly: FlatRing[][], x: number, y: number): boolean {
	for (let p = 0; p < outerRings.length; p++) {
		const outer = outerRings[p];
		// Cheap bbox rejection before expensive ray-cast.
		if (x < outer.minX || x > outer.maxX || y < outer.minY || y > outer.maxY) continue;
		if (!pointInFlatRing(outer, x, y)) continue;
		const holes = holesPerPoly[p];
		let inHole = false;
		for (const hole of holes) {
			if (x < hole.minX || x > hole.maxX || y < hole.minY || y > hole.maxY) continue;
			if (pointInFlatRing(hole, x, y)) { inHole = true; break; }
		}
		if (!inHole) return true;
	}
	return false;
}

// Pre-flatten a city boundary feature. Returns [outerRings, holesPerPoly].
// tolerance: simplification in meters — half a cell preserves sub-cell correctness.
function flattenBoundary(feature: Feature<Polygon | MultiPolygon>, tolerance: number): [FlatRing[], FlatRing[][]] {
	const outerRings: FlatRing[] = [];
	const holesPerPoly: FlatRing[][] = [];
	if (feature.geometry.type === "Polygon") {
		const rings = feature.geometry.coordinates;
		outerRings.push(flattenRing(rings[0], tolerance));
		holesPerPoly.push(rings.slice(1).map((r) => flattenRing(r, tolerance)));
	} else {
		for (const poly of feature.geometry.coordinates) {
			outerRings.push(flattenRing(poly[0], tolerance));
			holesPerPoly.push(poly.slice(1).map((r) => flattenRing(r, tolerance)));
		}
	}
	return [outerRings, holesPerPoly];
}
// ─────────────────────────────────────────────────────────────────────────────

// Constants
const DEFAULT_TILES_BASE_URL = "https://tiles.jsinha.com";

export interface City {
	id: string;
	osmId: string;
	name: string;
	displayName: string;
	boundary: Feature<Polygon | MultiPolygon>;
	flatOuter: FlatRing[];   // pre-flattened outer rings for fast PIP
	flatHoles: FlatRing[][]; // pre-flattened holes per polygon
	roadCells: Set<number> | null; // Road-only cells (async computed)
	roadTiles: string; // PMTiles filename for road data, e.g. "europe.pmtiles"
	source: "self-hosted";
	center?: { lat: number; lng: number }; // Cache center for distance lookups
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	source: "self-hosted";
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

	// Discovery progress tracking (two phases: location discovery, then road cell computation)
	private locationTotal = 0;
	private locationProcessed = 0;
	private roadCellTotal = 0;
	private roadCellProcessed = 0;

	// Road cell computation queue + concurrency pool
	private roadCellQueue: City[] = [];
	private activeCityCount = 0;
	private readonly MAX_CONCURRENT_CITIES = 5;

	// PMTiles Instance Cache (keyed by full URL)
	private pmtilesCache = new Map<string, PMTiles>();
	private tilesBaseUrl = DEFAULT_TILES_BASE_URL;

	// Self-hosted world lookup for reverse geocoding
	private worldLookup: WorldLookup;

	constructor() {
		this.worldLookup = new WorldLookup(`${this.tilesBaseUrl}/world-lookup.pmtiles`);
	}

	public handleMessage(event: MessageEvent<CityProcessorMessage>) {
		const { type, payload } = event.data;

		switch (type) {
			case "DISCOVER_CITIES":
				if (payload.tilesBaseUrl) this.setTilesBaseUrl(payload.tilesBaseUrl);
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

	private getPMTilesInstance(filename: string): PMTiles {
		const base = this.tilesBaseUrl || DEFAULT_TILES_BASE_URL;
		const url = `${base}/${filename}`;
		if (!this.pmtilesCache.has(url)) {
			this.pmtilesCache.set(url, new PMTiles(url));
		}
		return this.pmtilesCache.get(url)!;
	}

	private setTilesBaseUrl(url?: string) {
		if (!url) return;
		const trimmed = url.replace(/\/+$/, "");
		if (trimmed === this.tilesBaseUrl) return;
		this.tilesBaseUrl = trimmed;
		this.pmtilesCache.clear();
		this.worldLookup = new WorldLookup(`${this.tilesBaseUrl}/world-lookup.pmtiles`);
	}

	private async calculateViewportStats(
		bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
		cellSize: number,
	) {
		try {
			const centerLat = (bounds.minLat + bounds.maxLat) / 2;
			const centerLng = (bounds.minLng + bounds.maxLng) / 2;

			// Find the closest known city to determine which road tiles to use
			const closestCity = this.findClosestCity(centerLat, centerLng);

			if (!closestCity) {
				// No cities discovered yet — try a world lookup to find road tiles
				const lookupResult = await this.worldLookup.query(centerLat, centerLng);
				if (!lookupResult || !lookupResult.roadTiles) {
					self.postMessage({
						type: "VIEWPORT_STATS",
						payload: { percentage: 0 },
					});
					return;
				}

				const pmtiles = this.getPMTilesInstance(lookupResult.roadTiles);
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
				return;
			}

			const pmtiles = this.getPMTilesInstance(closestCity.roadTiles);

			const roadCells = await getRoadCellsForBbox(
				bounds.minLat,
				bounds.maxLat,
				bounds.minLng,
				bounds.maxLng,
				cellSize,
				14,
				true, // useCache
				pmtiles,
			);

			const percentage = computeVisitedPercentageForCells(roadCells, this.visitedCells);

			if (percentage === 0 && roadCells.size > 0 && this.visitedCells.size > 0) {
				console.debug(
					`Viewport 0% debug: RoadCells=${roadCells.size}, Visited=${this.visitedCells.size}`,
				);
			}

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
		if (this.isProcessing) return;
		this.isProcessing = true;

		// Reset progress counters for both phases
		this.locationTotal = 0;
		this.locationProcessed = 0;
		this.roadCellTotal = 0;
		this.roadCellProcessed = 0;

		try {
			const uniqueLocations = this.groupActivitiesByLocation(activities);
			this.locationTotal = uniqueLocations.length;

			this.postProgress();

			// Phase 1: Process all locations concurrently in small batches (no rate limiting needed)
			const BATCH_SIZE = 10;
			for (let i = 0; i < uniqueLocations.length; i += BATCH_SIZE) {
				const batch = uniqueLocations.slice(i, i + BATCH_SIZE);
				await Promise.all(batch.map(([lat, lng]) => this.identifyCity(lat, lng)));
				this.locationProcessed = Math.min(i + BATCH_SIZE, uniqueLocations.length);
				this.postProgress();
			}

			// Phase 2: Wait for road cell computation to finish
			// The roadCellTotal was set as cities were discovered
			// Add a timeout safeguard to prevent infinite stalling (5 minutes max)
			const MAX_WAIT_MS = 5 * 60 * 1000;
			const waitStart = Date.now();
			while (this.activeCityCount > 0 || this.roadCellQueue.length > 0) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				this.postProgress(); // Keep updating progress while waiting

				// Check for timeout
				if (Date.now() - waitStart > MAX_WAIT_MS) {
					console.warn(
						`Road cell computation timed out after ${MAX_WAIT_MS / 1000}s. ` +
							`Queue: ${this.roadCellQueue.length}, Active: ${this.activeCityCount}`,
					);
					// Force exit the loop - we'll show partial results
					this.roadCellQueue = [];
					this.activeCityCount = 0;
					break;
				}
			}

			this.postStats("COMPLETE");
		} catch (e) {
			console.error("City discovery failed in worker:", e);
		} finally {
			this.isProcessing = false;
		}
	}

	private groupActivitiesByLocation(activities: StravaActivity[]): Array<[number, number]> {
		const locations = new Map<string, [number, number]>();
		for (const activity of activities) {
			if (!activity.start_latlng || activity.start_latlng.length < 2) continue;
			const [lat, lng] = activity.start_latlng;
			// Round to 1 decimal place (~11km) to group nearby starts
			const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
			if (!locations.has(key)) {
				locations.set(key, [lat, lng]);
			}
		}
		return Array.from(locations.values());
	}

	/**
	 * Identify the city at a given lat/lng using the self-hosted world lookup.
	 * If a city is found and we haven't seen it before, fetch its full boundary
	 * GeoJSON and create the city entry.
	 */
	private async identifyCity(lat: number, lng: number) {
		try {
			const result = await this.worldLookup.query(lat, lng);

			if (!result || !result.osmId || !result.name) return;

			// Use osmId as the unique city key (globally unique, stable)
			const cityId = result.osmId;
			if (this.cities.has(cityId)) return;

			// Fetch the full city boundary GeoJSON
			await this.fetchCityBoundary(result, lat, lng);
		} catch (e) {
			console.warn("City identification failed:", e);
		}
	}

	/**
	 * Fetch the full city boundary GeoJSON from the self-hosted store
	 * and create the City entry.
	 */
	private async fetchCityBoundary(
		lookupResult: WorldLookupResult,
		originalLat: number,
		originalLng: number,
	) {
		try {
			// Check IndexedDB cache first
			const cached = await getCachedBoundary(lookupResult.osmId);
			if (cached) {
				this.createCity(cached, lookupResult, originalLat, originalLng);
				return;
			}

			const base = this.tilesBaseUrl || DEFAULT_TILES_BASE_URL;
			const url = `${base}/cities/${lookupResult.osmId}.geojson`;

			// Add timeout to prevent hanging requests from stalling the entire pipeline
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(timeoutId);

			if (!res.ok) {
				console.warn(`Failed to fetch city boundary for ${lookupResult.osmId}: ${res.status}`);
				return;
			}

			const raw = (await res.json()) as Feature;

			// Validate geometry type
			if (
				!raw.geometry ||
				(raw.geometry.type !== "Polygon" && raw.geometry.type !== "MultiPolygon")
			) {
				console.warn(`Invalid geometry type for ${lookupResult.osmId}:`, raw.geometry?.type);
				return;
			}

			const feature = raw as Feature<Polygon | MultiPolygon>;

			// Cache the boundary for future use
			await cacheBoundary(lookupResult.osmId, feature);

			this.createCity(feature, lookupResult, originalLat, originalLng);
		} catch (e) {
			console.warn(`Failed to fetch boundary for ${lookupResult.osmId}:`, e);
		}
	}

	private createCity(
		feature: Feature<Polygon | MultiPolygon>,
		lookupResult: WorldLookupResult,
		fallbackLat: number,
		fallbackLng: number,
	) {
		try {
			// Calculate center directly from boundary bbox (no expensive polygon rasterization)
			const bbox = this.getBoundaryBbox(feature);
			let center: { lat: number; lng: number };
			if (bbox) {
				center = {
					lat: (bbox.minLat + bbox.maxLat) / 2,
					lng: (bbox.minLng + bbox.maxLng) / 2,
				};
			} else {
				center = { lat: fallbackLat, lng: fallbackLng };
			}

			// tolerance = cellSize/2 — simplifies polygon to sub-cell precision
			const [flatOuter, flatHoles] = flattenBoundary(feature, this.cellSize / 2);

			const city: City = {
				id: lookupResult.osmId,
				osmId: lookupResult.osmId,
				name: lookupResult.name,
				displayName: lookupResult.name,
				boundary: feature,
				flatOuter,
				flatHoles,
				roadCells: null,
				roadTiles: lookupResult.roadTiles,
				source: "self-hosted",
				center,
			};

			this.cities.set(lookupResult.osmId, city);
			this.roadCellTotal++;
			this.postProgress();
			this.queueRoadCellComputation(city);
		} catch (e) {
			console.warn(`Failed to process boundary for ${lookupResult.osmId}:`, e);
		}
	}

	private queueRoadCellComputation(city: City) {
		this.roadCellQueue.push(city);
		this.processRoadCellQueue();
	}

	private processRoadCellQueue() {
		while (this.roadCellQueue.length > 0 && this.activeCityCount < this.MAX_CONCURRENT_CITIES) {
			const city = this.roadCellQueue.shift()!;
			this.activeCityCount++;
			this.computeRoadCellsForCity(city)
				.then(() => this.postStats("STATS_UPDATE"))
				.finally(() => {
					this.activeCityCount--;
					this.processRoadCellQueue();
				});
		}
	}

	private async computeRoadCellsForCity(city: City) {
		try {
			if (!city.roadTiles) {
				console.warn(`No road tiles filename for city ${city.id}`);
				return;
			}

			// Check cache first
			const cachedCells = await getCachedRoadCells(city.osmId, this.cellSize);
			if (cachedCells) {
				city.roadCells = cachedCells;
				console.debug(
					`[RoadCells] Using cached road cells for ${city.name} (${city.osmId}): ${cachedCells.size} cells`,
				);
				return;
			}

			const startTime = performance.now();
			const pmtiles = this.getPMTilesInstance(city.roadTiles);

			const bbox = this.getBoundaryBbox(city.boundary);
			if (!bbox) return;

			const { minLat, maxLat, minLng, maxLng } = bbox;

			const zoom = getAdaptiveZoom(minLat, maxLat, minLng, maxLng);
			const tileEstimate =
				Math.pow(2, zoom - 12) * ((maxLat - minLat) / 0.08) * ((maxLng - minLng) / 0.08);
			console.debug(
				`[RoadCells] Computing for ${city.name}: bbox=${(maxLat - minLat).toFixed(3)}°×${(maxLng - minLng).toFixed(3)}°, zoom=${zoom}, ~${Math.round(tileEstimate)} tiles`,
			);

			const roadCells = await getRoadCellsForBbox(
				minLat,
				maxLat,
				minLng,
				maxLng,
				this.cellSize,
				zoom,
				true, // useCache
				pmtiles,
			);

			const fetchTime = performance.now();
			console.debug(
				`[RoadCells] ${city.name}: fetched ${roadCells.size} raw road cells in ${((fetchTime - startTime) / 1000).toFixed(1)}s`,
			);

			// Filter road cells using inline ray-cast on pre-flattened meter-space rings.
			// centerX/centerY are already in Web Mercator meters — no coordinate conversion needed.
			// Yield every YIELD_INTERVAL iterations so network/IDB callbacks can fire while
			// this synchronous loop runs (otherwise the worker event loop is fully blocked).
			const filteredRoadCells = new Set<number>();
			let pipCount = 0;
			for (const v of roadCells) {
				const { x, y } = unpackCell(v);
				const centerX = x * this.cellSize + this.cellSize / 2;
				const centerY = y * this.cellSize + this.cellSize / 2;
				if (pointInFlatPolygon(city.flatOuter, city.flatHoles, centerX, centerY)) {
					filteredRoadCells.add(v);
				}
				if (++pipCount % YIELD_INTERVAL === 0) await yieldToEventLoop();
			}

			const pipTime = performance.now();
			console.debug(
				`[RoadCells] ${city.name}: PIP filter ${roadCells.size}→${filteredRoadCells.size} cells in ${((pipTime - fetchTime) / 1000).toFixed(2)}s`,
			);

			city.roadCells = filteredRoadCells;

			// Cache the computed road cells — fire-and-forget, don't block city completion.
			cacheRoadCells(city.osmId, filteredRoadCells, this.cellSize).catch(console.warn);

			const totalTime = performance.now();
			console.debug(
				`[RoadCells] ${city.name} (${city.osmId}): ${filteredRoadCells.size} cells (from ${roadCells.size} raw) in ${((totalTime - startTime) / 1000).toFixed(1)}s`,
			);
		} catch (e) {
			console.warn(`Failed to compute road cells for ${city.id}:`, e);
		} finally {
			this.roadCellProcessed++;
			this.postProgress();
		}
	}

	// Get lat/lng bounding box directly from the GeoJSON boundary
	private getBoundaryBbox(
		boundary: Feature<Polygon | MultiPolygon>,
	): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
		let minLat = 90,
			maxLat = -90,
			minLng = 180,
			maxLng = -180;

		const processCoords = (coords: number[][][]) => {
			for (const ring of coords) {
				for (const [lng, lat] of ring) {
					minLat = Math.min(minLat, lat);
					maxLat = Math.max(maxLat, lat);
					minLng = Math.min(minLng, lng);
					maxLng = Math.max(maxLng, lng);
				}
			}
		};

		if (boundary.geometry.type === "Polygon") {
			processCoords(boundary.geometry.coordinates);
		} else if (boundary.geometry.type === "MultiPolygon") {
			for (const poly of boundary.geometry.coordinates) {
				processCoords(poly);
			}
		}

		if (minLat > maxLat || minLng > maxLng) return null;
		return { minLat, maxLat, minLng, maxLng };
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
		if (stats.length > 0) {
			console.debug(`Posting stats (${type}):`, stats);
		}
		self.postMessage({
			type,
			payload: { stats },
		});
	}
}

const processor = new CityProcessor();
self.onmessage = (e) => processor.handleMessage(e);
