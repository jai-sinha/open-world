// Web Mercator projection utilities for converting lat/lng to meters
// Used for grid-based spatial indexing

const EARTH_RADIUS = 6378137; // meters (WGS84)
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS;

/**
 * Convert latitude/longitude to Web Mercator meters (EPSG:3857)
 */
export function latLngToMeters(lat: number, lng: number): { x: number; y: number } {
	const x = (lng * ORIGIN_SHIFT) / 180.0;
	let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360.0)) / (Math.PI / 180.0);
	y = (y * ORIGIN_SHIFT) / 180.0;
	return { x, y };
}

/**
 * Convert Web Mercator meters back to latitude/longitude
 */
export function metersToLatLng(x: number, y: number): { lat: number; lng: number } {
	const lng = (x / ORIGIN_SHIFT) * 180.0;
	let lat = (y / ORIGIN_SHIFT) * 180.0;
	lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180.0)) - Math.PI / 2.0);
	return { lat, lng };
}

/**
 * Convert point to grid cell coordinates
 */
export function pointToCell(x: number, y: number, cellSize: number): { x: number; y: number } {
	return {
		x: Math.floor(x / cellSize),
		y: Math.floor(y / cellSize),
	};
}

/**
 * Convert grid cell back to meter coordinates (center of cell)
 */
export function cellToPoint(
	cellX: number,
	cellY: number,
	cellSize: number,
): { x: number; y: number } {
	return {
		x: cellX * cellSize + cellSize / 2,
		y: cellY * cellSize + cellSize / 2,
	};
}

/**
 * Calculate cell key for Set/Map storage
 */
export function cellKey(cellX: number, cellY: number): string {
	return `${cellX},${cellY}`;
}

/**
 * Parse cell key back to coordinates
 */
export function parseCellKey(key: string): { x: number; y: number } {
	const [x, y] = key.split(",").map(Number);
	return { x, y };
}

/**
 * Calculate distance between two lat/lng points in meters (Haversine)
 */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLng / 2) *
			Math.sin(dLng / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return EARTH_RADIUS * c;
}

/**
 * Sample points along a polyline at regular intervals
 * Returns points in Web Mercator meters
 */
export function samplePolyline(
	points: Array<[number, number]>, // [lat, lng]
	stepMeters: number,
): Array<{ x: number; y: number }> {
	if (points.length === 0) return [];

	const samples: Array<{ x: number; y: number }> = [];
	let accumulatedDistance = 0;

	// Always include first point
	samples.push(latLngToMeters(points[0][0], points[0][1]));

	for (let i = 1; i < points.length; i++) {
		const [lat1, lng1] = points[i - 1];
		const [lat2, lng2] = points[i];

		const segmentDistance = haversineDistance(lat1, lng1, lat2, lng2);

		if (segmentDistance === 0) continue;

		// How many samples do we need in this segment?
		const remainingStep = stepMeters - accumulatedDistance;

		if (segmentDistance >= remainingStep) {
			// We can place samples in this segment
			let distanceInSegment = remainingStep;

			while (distanceInSegment <= segmentDistance) {
				// Interpolate point
				const ratio = distanceInSegment / segmentDistance;
				const lat = lat1 + (lat2 - lat1) * ratio;
				const lng = lng1 + (lng2 - lng1) * ratio;

				samples.push(latLngToMeters(lat, lng));
				distanceInSegment += stepMeters;
			}

			accumulatedDistance = segmentDistance - (distanceInSegment - stepMeters);
		} else {
			accumulatedDistance += segmentDistance;
		}
	}

	// Always include last point
	const lastPoint = points[points.length - 1];
	samples.push(latLngToMeters(lastPoint[0], lastPoint[1]));

	return samples;
}

/**
 * Trim first/last `distanceMeters` from a lat/lng polyline
 * Returns a new array of [lat, lng] points (or [] if polyline becomes too short).
 * Uses haversineDistance() defined above for distance calculations.
 */
export function trimPolylineByDistance(
	points: Array<[number, number]>, // [lat, lng]
	distanceMeters: number,
): Array<[number, number]> {
	// Keep previous guard for short lines / disabled trimming
	if (distanceMeters <= 0 || points.length < 3) return points;

	// ---- Trim start with interpolation on the cut segment ----
	let accumulated = 0;
	let startCutIndex = -1;
	let startPoint: [number, number] | null = null;

	for (let i = 1; i < points.length; i++) {
		const [lat1, lng1] = points[i - 1];
		const [lat2, lng2] = points[i];
		const segDist = haversineDistance(lat1, lng1, lat2, lng2);

		if (accumulated + segDist >= distanceMeters) {
			const needed = distanceMeters - accumulated;

			if (needed <= 0) {
				// Cut exactly at the previous point (rare)
				startPoint = points[i];
				startCutIndex = i + 1;
			} else if (needed >= segDist) {
				// Exactly at the segment end: use points[i] as start
				startPoint = points[i];
				startCutIndex = i + 1;
			} else {
				// Interpolate along segment from points[i-1] -> points[i]
				const ratio = needed / segDist;
				const cutLat = lat1 + (lat2 - lat1) * ratio;
				const cutLng = lng1 + (lng2 - lng1) * ratio;
				startPoint = [cutLat, cutLng];
				startCutIndex = i;
			}
			break;
		}

		accumulated += segDist;
	}

	// If we couldn't find a start cut (distance too large), nothing remains
	if (!startPoint) return [];

	// Build filtered polyline starting at the interpolated start point
	const filtered: Array<[number, number]> = [];
	filtered.push(startPoint);
	for (let k = startCutIndex; k < points.length; k++) {
		filtered.push(points[k]);
	}

	// Ensure there's something left to work with
	if (filtered.length < 2) return [];

	// ---- Trim end with interpolation on the cut segment ----
	let accumulatedEnd = 0;
	let endCutIndex = -1;
	let endPoint: [number, number] | null = null;

	for (let i = filtered.length - 1; i > 0; i--) {
		const [lat1, lng1] = filtered[i - 1];
		const [lat2, lng2] = filtered[i];
		const segDist = haversineDistance(lat1, lng1, lat2, lng2);

		if (accumulatedEnd + segDist >= distanceMeters) {
			const needed = distanceMeters - accumulatedEnd;

			if (needed <= 0) {
				// Cut exactly at filtered[i] (unlikely), keep up to filtered[i]
				endPoint = filtered[i - 1];
				endCutIndex = i - 1;
			} else if (needed >= segDist) {
				// Cut exactly at the segment start
				endPoint = filtered[i - 1];
				endCutIndex = i - 1;
			} else {
				// Cut inside this segment; keep from filtered[0] up to an interpolated point
				const keepDist = segDist - needed; // distance from segment start to final kept point
				const ratio = keepDist / segDist;
				const cutLat = lat1 + (lat2 - lat1) * ratio;
				const cutLng = lng1 + (lng2 - lng1) * ratio;
				endPoint = [cutLat, cutLng];
				endCutIndex = i - 1;
			}
			break;
		}

		accumulatedEnd += segDist;
	}

	// If no end cut was needed (distanceMeters is zero or too small), return filtered as-is
	if (!endPoint) {
		return filtered.length >= 2 ? filtered : [];
	}

	// Assemble final result up to the interpolated end point
	const result: Array<[number, number]> = [];
	for (let k = 0; k <= endCutIndex; k++) {
		result.push(filtered[k]);
	}
	result.push(endPoint);

	return result.length >= 2 ? result : [];
}

/**
 * Get bounding box of a set of cells
 */
export function getCellBounds(cells: Set<string>): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} | null {
	if (cells.size === 0) return null;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const key of cells) {
		const { x, y } = parseCellKey(key);
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}

	return { minX, minY, maxX, maxY };
}
