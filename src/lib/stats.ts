import type { Map as MapLibreMap } from "maplibre-gl";
import { latLngToMeters, pointToCell, cellKey, parseCellKey } from "./projection";

/**
 * Calculate the percentage of visible roads that have been explored.
 *
 * This function:
 * 1. Identifies visible road features in the current viewport
 * 2. Rasterizes them into grid cells
 * 3. Compares them against the user's visited cells
 * 4. Uses fuzzy matching (neighbor check) to account for GPS drift
 *
 * @param map The MapLibre map instance
 * @param visitedCells Set of visited cell keys ("x,y")
 * @param cellSize Grid cell size in meters
 * @returns Percentage of roads explored (0-100), or -1 if viewport is too large
 */
export function calculateViewportStats(
	map: MapLibreMap,
	visitedCells: Set<string>,
	cellSize: number,
): number {
	if (!map) return 0;

	// Get viewport bounds in meters for clipping
	const bounds = map.getBounds();
	const ne = bounds.getNorthEast();
	const sw = bounds.getSouthWest();
	const neMeters = latLngToMeters(ne.lat, ne.lng);
	const swMeters = latLngToMeters(sw.lat, sw.lng);

	const minX = Math.min(swMeters.x, neMeters.x);
	const maxX = Math.max(swMeters.x, neMeters.x);
	const minY = Math.min(swMeters.y, neMeters.y);
	const maxY = Math.max(swMeters.y, neMeters.y);

	// Performance check: if viewport is too large, skip calculation
	// 2m cells is roughly a 50km x 50km area with 50m cells
	const minCell = pointToCell(minX, minY, cellSize);
	const maxCell = pointToCell(maxX, maxY, cellSize);
	const cellCount = Math.abs((maxCell.x - minCell.x) * (maxCell.y - minCell.y));

	if (cellCount > 2_000_000) return -1;

	// Get visible features
	const canvas = map.getCanvas();
	const features = map.queryRenderedFeatures(
		[
			[0, 0],
			[canvas.width, canvas.height],
		],
		{},
	);

	const roadCells = new Set<string>();

	// Heuristic to identify road layers in standard styles (like Carto, Mapbox, etc.)
	const isRoadLayer = (id: string) => {
		const lower = id.toLowerCase();
		return (
			lower.includes("road") ||
			lower.includes("highway") ||
			lower.includes("transportation") ||
			lower.includes("tunnel") ||
			lower.includes("bridge")
		);
	};

	for (const feature of features) {
		if (!isRoadLayer(feature.layer.id)) continue;
		if (feature.geometry.type !== "LineString" && feature.geometry.type !== "MultiLineString")
			continue;

		const geometry = feature.geometry as any;
		const coordsList =
			geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;

		for (const coords of coordsList) {
			// coords is Array<[lng, lat]>
			for (let i = 0; i < coords.length - 1; i++) {
				const [lng1, lat1] = coords[i] as [number, number];
				const [lng2, lat2] = coords[i + 1] as [number, number];

				const p1 = latLngToMeters(lat1, lng1);
				const p2 = latLngToMeters(lat2, lng2);

				// Interpolate to find all grid cells touched by this segment
				const dx = p2.x - p1.x;
				const dy = p2.y - p1.y;
				const dist = Math.sqrt(dx * dx + dy * dy);

				// Step size: half cell size ensures we don't skip cells
				const steps = Math.ceil(dist / (cellSize / 2));

				for (let s = 0; s <= steps; s++) {
					const t = steps === 0 ? 0 : s / steps;
					const x = p1.x + dx * t;
					const y = p1.y + dy * t;

					// Clip to viewport
					if (x < minX || x > maxX || y < minY || y > maxY) continue;

					const cell = pointToCell(x, y, cellSize);
					roadCells.add(cellKey(cell.x, cell.y));
				}
			}
		}
	}

	if (roadCells.size === 0) return 0;

	let visitedRoadCells = 0;
	for (const cell of roadCells) {
		if (visitedCells.has(cell)) {
			visitedRoadCells++;
		} else {
			// Fuzzy match: check neighbors (3x3 grid)
			// This handles GPS drift or slight misalignment between map roads and activity tracks
			const { x, y } = parseCellKey(cell);
			let found = false;
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					if (dx === 0 && dy === 0) continue;
					if (visitedCells.has(cellKey(x + dx, y + dy))) {
						found = true;
						break;
					}
				}
				if (found) break;
			}
			if (found) visitedRoadCells++;
		}
	}

	return (visitedRoadCells / roadCells.size) * 100;
}
