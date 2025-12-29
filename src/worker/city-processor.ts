import type { Feature, Polygon, MultiPolygon } from "geojson";
import { metersToLatLng, rasterizePolygon } from "../lib/projection";
import type { StravaActivity } from "../types";
import { computeCityStats, computeVisitedPercentageForCells } from "../lib/stats";
import { getRoadCellsForBbox } from "../lib/tiles";
import { getPMTilesFilename } from "../lib/pmtiles-mapping";
import { PMTiles } from "pmtiles";

// Constants
const TILES_BASE_URL = "https://pub-fe917f235736482c991c98f959f63e11.r2.dev";
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const USER_AGENT = "OpenWorld-Exploration/1.0";
const RATE_LIMIT_DELAY_MS = 1100; // Nominatim requires 1s delay

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
	center?: { lat: number; lng: number }; // Cache center for distance lookups
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	source: "nominatim";
}

interface NominatimAddress {
	city?: string;
	town?: string;
	village?: string;
	municipality?: string;
	country: string;
	state?: string;
	region?: string;
	province?: string;
}

// Worker Message Types
export type CityProcessorMessage =
	| {
			type: "DISCOVER_CITIES";
			payload: {
				activities: StravaActivity[];
				visitedCells: string[];
				cellSize: number;
			};
	  }
	| {
			type: "UPDATE_VISITED_CELLS";
			payload: {
				visitedCells: string[];
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

class CityProcessor {
	private cities = new Map<string, City>();
	private visitedCells = new Set<string>();
	private cellSize = 20;
	private isProcessing = false;

	// Discovery progress tracking
	private discoveryTotal = 0;
	private discoveryProcessed = 0;

	// Rate limiting
	private lastApiRequestTime = 0;
	private roadCellQueue: City[] = [];
	private isProcessingRoadCells = false;

	// PMTiles Instance Cache
	private pmtilesCache = new Map<string, PMTiles>();

	constructor() {}

	public handleMessage(event: MessageEvent<CityProcessorMessage>) {
		const { type, payload } = event.data;

		switch (type) {
			case "DISCOVER_CITIES":
				this.visitedCells = new Set(payload.visitedCells);
				this.cellSize = payload.cellSize;
				this.discoverCitiesFromActivities(payload.activities);
				break;
			case "UPDATE_VISITED_CELLS":
				this.visitedCells = new Set(payload.visitedCells);
				this.postStats("STATS_UPDATE");
				break;
			case "CALCULATE_VIEWPORT_STATS":
				this.calculateViewportStats(payload.bounds, payload.cellSize);
				break;
		}
	}

	private getPMTilesInstance(filename: string): PMTiles {
		const url = `${TILES_BASE_URL}/${filename}`;
		if (!this.pmtilesCache.has(url)) {
			this.pmtilesCache.set(url, new PMTiles(url));
		}
		return this.pmtilesCache.get(url)!;
	}

	private async calculateViewportStats(
		bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
		cellSize: number,
	) {
		try {
			// 1. Determine which region/PMTiles to use based on viewport center
			const centerLat = (bounds.minLat + bounds.maxLat) / 2;
			const centerLng = (bounds.minLng + bounds.maxLng) / 2;

			const closestCity = this.findClosestCity(centerLat, centerLng);

			if (!closestCity) {
				// If we don't know where we are, we can't fetch tiles efficiently yet.
				// (Future: could use a coarse world-region map)
				self.postMessage({
					type: "VIEWPORT_STATS",
					payload: { percentage: 0 },
				});
				return;
			}

			const pmtilesFile = getPMTilesFilename(closestCity.country, closestCity.region);
			if (!pmtilesFile) {
				self.postMessage({
					type: "VIEWPORT_STATS",
					payload: { percentage: 0 },
				});
				return;
			}

			const pmtiles = this.getPMTilesInstance(pmtilesFile);

			// 2. Fetch road cells for the viewport
			// We enable caching (useCache=true) because we implemented LRU eviction in tiles.ts
			// This ensures we don't re-fetch tiles when panning slightly, but don't bloat memory.
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
			// Simple Euclidean distance is enough for this heuristic
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
		this.discoveryProcessed = 0;
		this.discoveryTotal = 0;

		try {
			const uniqueLocations = this.groupActivitiesByLocation(activities);
			this.discoveryTotal = uniqueLocations.length;

			this.postProgress();

			for (const [lat, lng] of uniqueLocations) {
				await this.identifyCity(lat, lng);
				this.discoveryProcessed++;
				this.postProgress();
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

	private async identifyCity(lat: number, lng: number) {
		try {
			await this.enforceRateLimit();

			const response = await fetch(
				`${NOMINATIM_BASE_URL}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`,
				{ headers: { "User-Agent": USER_AGENT } },
			);
			this.lastApiRequestTime = Date.now();

			if (!response.ok) return;

			const data = await response.json();
			const address = data.address as NominatimAddress;

			const cityName = address.city || address.town || address.village || address.municipality;
			const country = address.country;
			const region = address.state || address.region || address.province;

			if (!cityName || !country) return;

			const cityId = `${cityName}, ${country}`;
			if (this.cities.has(cityId)) return;

			// Fallback to Nominatim
			await this.fetchCityBoundaryFromNominatim(cityName, country, region, cityId);
		} catch (e) {
			console.warn("City identification failed:", e);
		}
	}

	private async fetchCityBoundaryFromNominatim(
		city: string,
		country: string,
		region: string | undefined,
		cityId: string,
	) {
		try {
			await this.enforceRateLimit();

			const query = `${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(
				city + ", " + country,
			)}&format=json&polygon_geojson=1&limit=1`;

			const res = await fetch(query, { headers: { "User-Agent": USER_AGENT } });
			this.lastApiRequestTime = Date.now();

			if (!res.ok) return;

			const data = await res.json();
			if (data?.[0]?.geojson) {
				const geojson = data[0].geojson;
				if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
					this.createCity(geojson, cityId, city, country, region, "nominatim");
				}
			}
		} catch (e) {
			console.warn(`Failed to fetch boundary for ${cityId} from Nominatim:`, e);
		}
	}

	private createCity(
		geometry: Polygon | MultiPolygon,
		cityId: string,
		cityName: string,
		country: string,
		region: string | undefined,
		source: "nominatim",
	) {
		try {
			const feature: Feature<Polygon | MultiPolygon> = {
				type: "Feature",
				properties: {},
				geometry,
			};

			const gridCells = rasterizePolygon(feature, this.cellSize);

			// Calculate center for heuristic lookups
			const bounds = this.getCityBounds(gridCells);
			let center = undefined;
			if (bounds) {
				const swLatLng = metersToLatLng(
					bounds.minX * this.cellSize + this.cellSize / 2,
					bounds.minY * this.cellSize + this.cellSize / 2,
				);
				const neLatLng = metersToLatLng(
					bounds.maxX * this.cellSize + this.cellSize / 2,
					bounds.maxY * this.cellSize + this.cellSize / 2,
				);
				center = {
					lat: (swLatLng.lat + neLatLng.lat) / 2,
					lng: (swLatLng.lng + neLatLng.lng) / 2,
				};
			}

			const city: City = {
				id: cityId,
				name: cityName,
				displayName: cityId,
				country,
				region,
				boundary: feature,
				gridCells,
				roadCells: null,
				source,
				center,
			};

			this.cities.set(cityId, city);
			this.queueRoadCellComputation(city);
		} catch (e) {
			console.warn(`Failed to process boundary for ${cityId}:`, e);
		}
	}

	private queueRoadCellComputation(city: City) {
		this.roadCellQueue.push(city);
		this.processRoadCellQueue();
	}

	private async processRoadCellQueue() {
		if (this.isProcessingRoadCells || this.roadCellQueue.length === 0) return;

		this.isProcessingRoadCells = true;

		while (this.roadCellQueue.length > 0) {
			const city = this.roadCellQueue.shift()!;
			await this.computeRoadCellsForCity(city);
			// Update stats after each city is processed so UI updates incrementally
			this.postStats("STATS_UPDATE");
		}

		this.isProcessingRoadCells = false;
	}

	private async computeRoadCellsForCity(city: City) {
		try {
			const pmtilesFile = getPMTilesFilename(city.country, city.region);
			if (!pmtilesFile) {
				console.warn(`No road tiles available for ${city.country} - ${city.region}`);
				return;
			}

			const pmtiles = this.getPMTilesInstance(pmtilesFile);

			const bounds = this.getCityBounds(city.gridCells);
			if (!bounds) return;

			const swLatLng = metersToLatLng(
				bounds.minX * this.cellSize + this.cellSize / 2,
				bounds.minY * this.cellSize + this.cellSize / 2,
			);
			const neLatLng = metersToLatLng(
				bounds.maxX * this.cellSize + this.cellSize / 2,
				bounds.maxY * this.cellSize + this.cellSize / 2,
			);

			const roadCells = await getRoadCellsForBbox(
				Math.min(swLatLng.lat, neLatLng.lat),
				Math.max(swLatLng.lat, neLatLng.lat),
				Math.min(swLatLng.lng, neLatLng.lng),
				Math.max(swLatLng.lng, neLatLng.lng),
				this.cellSize,
				14,
				true, // useCache
				pmtiles,
			);

			city.roadCells = roadCells;
		} catch (e) {
			console.warn(`Failed to compute road cells for ${city.id}:`, e);
		}
	}

	private getCityBounds(cells: Set<string>) {
		if (cells.size === 0) return null;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		for (const key of cells) {
			const [xStr, yStr] = key.split(",");
			const x = parseInt(xStr, 10);
			const y = parseInt(yStr, 10);
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}

		return { minX, minY, maxX, maxY };
	}

	private async enforceRateLimit() {
		const timeSinceLast = Date.now() - this.lastApiRequestTime;
		if (timeSinceLast < RATE_LIMIT_DELAY_MS) {
			await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS - timeSinceLast));
		}
	}

	private postProgress() {
		self.postMessage({
			type: "PROGRESS",
			payload: { processed: this.discoveryProcessed, total: this.discoveryTotal },
		});
	}

	private postStats(type: "COMPLETE" | "STATS_UPDATE") {
		// Note: computeCityStats expects Iterable<City> where City matches the interface in stats.ts
		// Our local City interface is structurally compatible.
		const stats = computeCityStats(this.cities.values(), this.visitedCells);
		self.postMessage({
			type,
			payload: { stats },
		});
	}
}

const processor = new CityProcessor();
self.onmessage = (e) => processor.handleMessage(e);
