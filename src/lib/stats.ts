import type { City, CityStats } from "./geocoding/city-manager";
import { cellKey, parseCellKey } from "./projection";

// ============ Core visited cell metrics ============

export function computeVisitedCountForCells(
	targetCells: Set<string>,
	visitedCells: Set<string>,
): number {
	if (targetCells.size === 0) return 0;
	let visited = 0;
	for (const cell of targetCells) {
		if (visitedCells.has(cell)) {
			visited++;
			continue;
		}
		const { x, y } = parseCellKey(cell);
		let found = false;
		// Fuzzy match: check 3x3 grid around the target cell to account for GPS drift
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
		if (found) visited++;
	}
	return visited;
}

export function computeVisitedPercentageForCells(
	targetCells: Set<string>,
	visitedCells: Set<string>,
): number {
	const visited = computeVisitedCountForCells(targetCells, visitedCells);
	return targetCells.size === 0 ? 0 : (visited / targetCells.size) * 100;
}

// ============ City stats ============

export function computeCityStats(cities: Iterable<City>, visitedCells: Set<string>): CityStats[] {
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
			});
		}
	}
	return stats.sort((a, b) => b.percentage - a.percentage).slice(0, 20);
}
