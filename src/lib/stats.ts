import type { City, CityStats } from "./geocoding/city-manager";
import { CELL_NEIGHBOR_OFFSETS } from "./projection";

// ============ Core visited cell metrics ============

export function computeVisitedCountForCells(
	targetCells: Set<number>,
	visitedCells: Set<number>,
): number {
	if (targetCells.size === 0) return 0;
	let visited = 0;
	for (const v of targetCells) {
		if (visitedCells.has(v)) {
			visited++;
			continue;
		}
		// Fuzzy match: check 8 neighbors using precomputed integer offsets (no unpack needed)
		let found = false;
		for (const off of CELL_NEIGHBOR_OFFSETS) {
			if (visitedCells.has(v + off)) {
				found = true;
				break;
			}
		}
		if (found) visited++;
	}
	return visited;
}

export function computeVisitedPercentageForCells(
	targetCells: Set<number>,
	visitedCells: Set<number>,
): number {
	const visited = computeVisitedCountForCells(targetCells, visitedCells);
	return targetCells.size === 0 ? 0 : (visited / targetCells.size) * 100;
}

// ============ City stats ============

export function computeCityStats(cities: Iterable<City>, visitedCells: Set<number>): CityStats[] {
	const stats: CityStats[] = [];
	for (const city of cities) {
		// Only show stats if road cells are computed
		if (city.roadCells === null) continue;

		const visitedCount = computeVisitedCountForCells(city.roadCells, visitedCells);

		if (city.roadCells.size > 0) {
			stats.push({
				cityId: city.id,
				displayName: city.displayName,
				totalCells: city.roadCells.size,
				visitedCount,
				percentage: city.roadCells.size === 0 ? 0 : (visitedCount / city.roadCells.size) * 100,
				source: city.source,
				center: city.center,
			});
		}
	}
	return stats.sort((a, b) => b.percentage - a.percentage).slice(0, 10);
}
