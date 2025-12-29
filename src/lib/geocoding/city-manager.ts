import type { Feature, Polygon, MultiPolygon } from "geojson";
import { metersToLatLng, rasterizePolygon } from "../projection";
import type { StravaActivity } from "../../types";
import { cityBoundaryLoader } from "./city-data/loader";
import { computeCityStats } from "../stats";
import { getRoadCellsForBbox, setRoadPMTilesURL } from "../tiles";
import { getPMTilesFilename } from "../pmtiles-mapping";

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

export class CityManager {
	private cities = new Map<string, City>();
	private visitedCells: Set<string>;
	private cellSize: number;
	private isProcessing = false;
	private bundleLoaded = false;

	// Discovery progress tracking
	private discoveryTotal = 0;
	private discoveryProcessed = 0;

	// Rate limiting
	private lastApiRequestTime = 0;
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
			if (!this.bundleLoaded) {
				await this.initializeBundle();
			}

			const uniqueLocations = this.groupActivitiesByLocation(activities);
			this.discoveryTotal = uniqueLocations.length;

			this.notifyDiscoveryStart();

			for (const [lat, lng] of uniqueLocations) {
				await this.identifyCity(lat, lng);
				this.discoveryProcessed++;
				onProgress?.(this.discoveryProcessed, this.discoveryTotal);
				this.notifyDiscoveryProgress();
			}

			return this.getStats();
		} finally {
			this.isProcessing = false;
			this.notifyDiscoveryComplete();
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

			// Try bundle first
			const bundleBoundary = cityBoundaryLoader.getByID(cityId);
			const geom = bundleBoundary?.geometry;
			if (geom && (geom.type === "Polygon" || geom.type === "MultiPolygon")) {
				this.createCity(geom, cityId, cityName, country, region, "bundle");
				return;
			}

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
		source: "bundle" | "nominatim",
	) {
		try {
			const feature: Feature<Polygon | MultiPolygon> = {
				type: "Feature",
				properties: {},
				geometry,
			};

			const gridCells = rasterizePolygon(feature, this.cellSize);

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
			// getRoadCellsForBbox hits R2, which doesn't need strict 1s throttling like Nominatim.
			// But let's keep a small delay to yield to UI.
			await new Promise((resolve) => setTimeout(resolve, 50));
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

	// --- Event Dispatchers ---

	private notifyDiscoveryStart() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-discovery-start", { detail: { total: this.discoveryTotal } }),
			);
		}
	}

	private notifyDiscoveryProgress() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-discovery-progress", {
					detail: { processed: this.discoveryProcessed, total: this.discoveryTotal },
				}),
			);
		}
	}

	private notifyDiscoveryComplete() {
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("city-discovery-complete", { detail: { stats: this.getStats() } }),
			);
		}
	}

	public getStats(): CityStats[] {
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
		return computeCityStats(this.cities.values(), this.visitedCells);
	}

	public getDiscoveryProgress(): { processed: number; total: number } {
		return { processed: this.discoveryProcessed, total: this.discoveryTotal };
	}
}
