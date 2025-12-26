import { point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon, MultiPolygon, Position } from "geojson";
import {
	latLngToMeters,
	metersToLatLng,
	pointToCell,
	cellKey,
	cellToPoint,
	rasterizePolygon,
} from "../projection";
import type { StravaActivity } from "../../types";
import { cityBoundaryLoader } from "./city-data/loader";
import { computeCityStats } from "../stats";
import { getRoadCellsForBbox, setRoadPMTilesURL } from "../tiles";
import { getPMTilesFilename } from "../pmtiles-mapping";

// TODO: Replace with your actual R2 bucket URL or proxy endpoint
const TILES_BASE_URL = "https://tiles.open-world.dev";

export interface City {
	id: string;
	name: string;
	displayName: string;
	country: string;
	region?: string;
	boundary: Feature<Polygon | MultiPolygon>;
	gridCells: Set<string>; // All cells in polygon
	roadCells: Set<string> | null; // Road-only cells (async computed)
	source: "bundle" | "nominatim";
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	source: "bundle" | "nominatim";
}

export class CityManager {
	private cities = new Map<string, City>();
	private visitedCells: Set<string>;
	private cellSize: number;
	private isProcessing = false;
	private bundleLoaded = false;

	// Discovery progress tracking (number of unique locations being processed)
	private discoveryTotal = 0;
	private discoveryProcessed = 0;

	// Rate limiting for API calls
	private lastNominatimRequest = 0;
	private lastOverpassRequest = 0;
	private roadCellQueue: City[] = [];
	private isProcessingRoadCells = false;

	constructor(visitedCells: Set<string>, cellSize: number) {
		this.visitedCells = visitedCells;
		this.cellSize = cellSize;

		this.initializeBundle();
	}

	private async initializeBundle() {
		try {
			await cityBoundaryLoader.load();
			this.bundleLoaded = true;
		} catch (e) {
			console.warn("Failed to load city boundary bundle, will fall back to Nominatim:", e);
			this.bundleLoaded = false;
		}
	}

	public updateVisitedCells(cells: Set<string>) {
		this.visitedCells = cells;
	}

	public async discoverCitiesFromActivities(
		activities: StravaActivity[],
		onProgress?: (processed: number, total: number) => void,
	): Promise<CityStats[]> {
		if (this.isProcessing) return this.getStats();
		this.isProcessing = true;
		this.discoveryProcessed = 0;
		this.discoveryTotal = 0;

		try {
			// Ensure bundle is loaded
			if (!this.bundleLoaded) {
				await this.initializeBundle();
			}

			// Group activities by approximate location (0.1 deg ~ 11km) to reduce API calls
			const locations = new Map<string, [number, number]>();
			for (const activity of activities) {
				if (!activity.start_latlng || activity.start_latlng.length < 2) continue;
				const [lat, lng] = activity.start_latlng;
				// Round to 1 decimal place
				const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
				if (!locations.has(key)) {
					locations.set(key, [lat, lng]);
				}
			}

			// Process locations to find new cities
			const uniqueLocations = Array.from(locations.values());
			this.discoveryTotal = uniqueLocations.length;

			// Notify UI listeners that discovery is starting
			if (typeof window !== "undefined") {
				window.dispatchEvent(
					new CustomEvent("city-discovery-start", { detail: { total: this.discoveryTotal } }),
				);
			}

			// Process each location and report progress after each one finishes
			for (const [lat, lng] of uniqueLocations) {
				await this.identifyCity(lat, lng);

				// update progress counters and notify listeners
				this.discoveryProcessed++;
				onProgress?.(this.discoveryProcessed, this.discoveryTotal);

				if (typeof window !== "undefined") {
					window.dispatchEvent(
						new CustomEvent("city-discovery-progress", {
							detail: { processed: this.discoveryProcessed, total: this.discoveryTotal },
						}),
					);
				}
			}

			return this.getStats();
		} finally {
			this.isProcessing = false;

			// Dispatch completion event with final stats
			if (typeof window !== "undefined") {
				window.dispatchEvent(
					new CustomEvent("city-discovery-complete", { detail: { stats: this.getStats() } }),
				);
			}
		}
	}

	private async identifyCity(lat: number, lng: number) {
		try {
			// Respect Nominatim rate limit (1 req/sec)
			const timeSinceLastNominatim = Date.now() - this.lastNominatimRequest;
			if (timeSinceLastNominatim < 1100) {
				await new Promise((resolve) => setTimeout(resolve, 1100 - timeSinceLastNominatim));
			}

			// 1. Reverse geocode to get city name
			const response = await fetch(
				`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`,
				{ headers: { "User-Agent": "OpenWorld-Exploration/1.0" } },
			);
			this.lastNominatimRequest = Date.now();

			if (!response.ok) return;

			const data = await response.json();
			const address = data.address;

			// Try to find the most relevant administrative boundary name
			const cityName = address.city || address.town || address.village || address.municipality;
			const country = address.country;
			const region = address.state || address.region || address.province;

			if (!cityName) return;

			const cityId = `${cityName}, ${country}`;

			// If we already track this city, skip
			if (this.cities.has(cityId)) return;

			// 2. Try to fetch boundary from bundle first
			const bundleBoundary = cityBoundaryLoader.getByID(cityId);
			if (bundleBoundary && bundleBoundary.geometry) {
				this.processCityBoundary(
					bundleBoundary.geometry,
					cityId,
					cityName,
					country,
					region,
					"bundle",
				);
				return;
			}

			// 3. Fall back to Nominatim if not in bundle
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
			// Respect Nominatim rate limit (1 req/sec)
			const timeSinceLastNominatim = Date.now() - this.lastNominatimRequest;
			if (timeSinceLastNominatim < 1100) {
				await new Promise((resolve) => setTimeout(resolve, 1100 - timeSinceLastNominatim));
			}

			// Request Polygon/MultiPolygon GeoJSON
			const query = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
				city + ", " + country,
			)}&format=json&polygon_geojson=1&limit=1`;

			const res = await fetch(query, { headers: { "User-Agent": "OpenWorld-Exploration/1.0" } });
			this.lastNominatimRequest = Date.now();

			if (!res.ok) return;

			const data = await res.json();
			if (data && data.length > 0 && data[0].geojson) {
				const geojson = data[0].geojson;

				if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
					this.processCityBoundary(geojson, cityId, city, country, region, "nominatim");
				}
			}
		} catch (e) {
			console.warn(`Failed to fetch boundary for ${cityId} from Nominatim:`, e);
		}
	}

	private processCityBoundary(
		geometry: any,
		cityId: string,
		cityName: string,
		country: string,
		region: string | undefined,
		source: "bundle" | "nominatim",
	) {
		try {
			const feature: Feature<Polygon | MultiPolygon> = {
				type: "Feature",
				properties: {},
				geometry,
			};

			// Rasterize the polygon into grid cells
			const gridCells = rasterizePolygon(feature, this.cellSize);

			const city: City = {
				id: cityId,
				name: cityName,
				displayName: cityId,
				country,
				region,
				boundary: feature,
				gridCells,
				roadCells: null, // Will be computed async
				source,
			};

			this.cities.set(cityId, city);

			// Queue road cell computation (will be processed sequentially)
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

			// Respect Overpass rate limit (1 req/sec)
			const timeSinceLastOverpass = Date.now() - this.lastOverpassRequest;
			if (timeSinceLastOverpass < 1100) {
				await new Promise((resolve) => setTimeout(resolve, 1100 - timeSinceLastOverpass));
			}

			await this.computeRoadCellsForCity(city);
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

			setRoadPMTilesURL(`${TILES_BASE_URL}/${pmtilesFile}`);

			// Get bbox of city's grid cells
			const bounds = this.getCityBounds(city.gridCells);
			if (!bounds) return;

			// Convert grid bounds back to lat/lng
			const swMeters = {
				x: bounds.minX * this.cellSize + this.cellSize / 2,
				y: bounds.minY * this.cellSize + this.cellSize / 2,
			};
			const neMeters = {
				x: bounds.maxX * this.cellSize + this.cellSize / 2,
				y: bounds.maxY * this.cellSize + this.cellSize / 2,
			};

			const swLatLng = metersToLatLng(swMeters.x, swMeters.y);
			const neLatLng = metersToLatLng(neMeters.x, neMeters.y);

			// Fetch road cells from tile source
			const roadCells = await getRoadCellsForBbox(
				Math.min(swLatLng.lat, neLatLng.lat),
				Math.max(swLatLng.lat, neLatLng.lat),
				Math.min(swLatLng.lng, neLatLng.lng),
				Math.max(swLatLng.lng, neLatLng.lng),
				this.cellSize,
			);

			this.lastOverpassRequest = Date.now();

			// Store road cells and update stats
			city.roadCells = roadCells;
		} catch (e) {
			console.warn(`Failed to compute road cells for ${city.id}:`, e);
		}
	}

	private getCityBounds(
		cells: Set<string>,
	): { minX: number; minY: number; maxX: number; maxY: number } | null {
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

	public getStats(): CityStats[] {
		// While city discovery is running, return a single "progress" stat
		if (this.isProcessing) {
			return [
				{
					cityId: "processing",
					displayName: "Processing cities...",
					totalCells: this.discoveryTotal,
					visitedCount: this.discoveryProcessed,
					percentage:
						this.discoveryTotal > 0 ? (this.discoveryProcessed / this.discoveryTotal) * 100 : 0,
					source: "bundle",
				},
			];
		}

		// Delegate to shared stats computation
		return computeCityStats(this.cities.values(), this.visitedCells);
	}

	public getDiscoveryProgress(): { processed: number; total: number } {
		return { processed: this.discoveryProcessed, total: this.discoveryTotal };
	}
}
