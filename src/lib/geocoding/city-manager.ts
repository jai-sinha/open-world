import { point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon, MultiPolygon, Position } from "geojson";
import { latLngToMeters, metersToLatLng, pointToCell, cellKey, cellToPoint } from "../projection";
import type { StravaActivity } from "../../types";
import { cityBoundaryLoader } from "./city-data/loader";

export interface City {
	id: string;
	name: string;
	displayName: string;
	boundary: Feature<Polygon | MultiPolygon>;
	gridCells: Set<string>;
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

	constructor(visitedCells: Set<string>, cellSize: number) {
		this.visitedCells = visitedCells;
		this.cellSize = cellSize;

		// Load the city boundary bundle at startup (non-blocking)
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

	public async discoverCitiesFromActivities(activities: StravaActivity[]): Promise<CityStats[]> {
		if (this.isProcessing) return this.getStats();
		this.isProcessing = true;

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

			// Process in chunks
			for (const [lat, lng] of uniqueLocations) {
				await this.identifyCity(lat, lng);
			}

			return this.getStats();
		} finally {
			this.isProcessing = false;
		}
	}

	private async identifyCity(lat: number, lng: number) {
		try {
			// 1. Reverse geocode to get city name
			const response = await fetch(
				`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`,
				{ headers: { "User-Agent": "OpenWorld-Exploration/1.0" } },
			);

			if (!response.ok) return;

			const data = await response.json();
			const address = data.address;

			// Try to find the most relevant administrative boundary name
			const cityName = address.city || address.town || address.village || address.municipality;
			const country = address.country;

			if (!cityName) return;

			const cityId = `${cityName}, ${country}`;

			// If we already track this city, skip
			if (this.cities.has(cityId)) return;

			// 2. Try to fetch boundary from bundle first
			const bundleBoundary = cityBoundaryLoader.getByID(cityId);
			if (bundleBoundary && bundleBoundary.geometry) {
				this.processCityBoundary(bundleBoundary.geometry, cityId, cityName, "bundle");
				return;
			}

			// 3. Fall back to Nominatim if not in bundle
			await this.fetchCityBoundaryFromNominatim(cityName, country, cityId);

			// Respect Nominatim rate limit (1 req/sec absolute max)
			await new Promise((resolve) => setTimeout(resolve, 1100));
		} catch (e) {
			console.warn("City identification failed:", e);
		}
	}

	private async fetchCityBoundaryFromNominatim(city: string, country: string, cityId: string) {
		try {
			// Request Polygon/MultiPolygon GeoJSON
			const query = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
				city + ", " + country,
			)}&format=json&polygon_geojson=1&limit=1`;

			const res = await fetch(query, { headers: { "User-Agent": "OpenWorld-Exploration/1.0" } });
			if (!res.ok) return;

			const data = await res.json();
			if (data && data.length > 0 && data[0].geojson) {
				const geojson = data[0].geojson;

				if (geojson.type === "Polygon" || geojson.type === "MultiPolygon") {
					this.processCityBoundary(geojson, cityId, city, "nominatim");
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
		source: "bundle" | "nominatim",
	) {
		try {
			const feature: Feature<Polygon | MultiPolygon> = {
				type: "Feature",
				properties: {},
				geometry,
			};

			// Rasterize the polygon into grid cells
			const gridCells = this.rasterizePolygon(feature);

			this.cities.set(cityId, {
				id: cityId,
				name: cityName,
				displayName: cityId,
				boundary: feature,
				gridCells,
				source,
			});
		} catch (e) {
			console.warn(`Failed to process boundary for ${cityId}:`, e);
		}
	}

	private rasterizePolygon(feature: Feature<Polygon | MultiPolygon>): Set<string> {
		const cells = new Set<string>();

		// Calculate bbox in lat/lng
		let minLat = 90,
			maxLat = -90,
			minLng = 180,
			maxLng = -180;

		const processCoords = (coords: Position[][]) => {
			for (const ring of coords) {
				for (const [lng, lat] of ring) {
					minLat = Math.min(minLat, lat);
					maxLat = Math.max(maxLat, lat);
					minLng = Math.min(minLng, lng);
					maxLng = Math.max(maxLng, lng);
				}
			}
		};

		if (feature.geometry.type === "Polygon") {
			processCoords(feature.geometry.coordinates);
		} else if (feature.geometry.type === "MultiPolygon") {
			for (const poly of feature.geometry.coordinates) {
				processCoords(poly);
			}
		}

		// Convert bbox to meters
		const sw = latLngToMeters(minLat, minLng);
		const ne = latLngToMeters(maxLat, maxLng);

		// Get grid range
		const minCell = pointToCell(sw.x, sw.y, this.cellSize);
		const maxCell = pointToCell(ne.x, ne.y, this.cellSize);

		// Iterate through all cells in the bounding box
		for (let x = minCell.x; x <= maxCell.x; x++) {
			for (let y = minCell.y; y <= maxCell.y; y++) {
				// Check center of cell
				const centerMeters = cellToPoint(x, y, this.cellSize);
				const centerLatLng = metersToLatLng(centerMeters.x, centerMeters.y);

				// Turf expects [lng, lat]
				if (booleanPointInPolygon(point([centerLatLng.lng, centerLatLng.lat]), feature)) {
					cells.add(cellKey(x, y));
				}
			}
		}

		return cells;
	}

	public getStats(): CityStats[] {
		const stats: CityStats[] = [];

		for (const city of this.cities.values()) {
			let visitedCount = 0;

			// Count intersections
			for (const cell of city.gridCells) {
				if (this.visitedCells.has(cell)) {
					visitedCount++;
				}
			}

			if (city.gridCells.size > 0) {
				stats.push({
					cityId: city.id,
					displayName: city.displayName,
					totalCells: city.gridCells.size,
					visitedCount,
					percentage: (visitedCount / city.gridCells.size) * 100,
					source: city.source,
				});
			}
		}

		// Return top 10 by percentage
		return stats.sort((a, b) => b.percentage - a.percentage).slice(0, 10);
	}
}
