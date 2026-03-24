// Grid processing utilities for marking visited cells and merging to rectangles
// This is the core algorithm for efficient exploration visualization

import type { Rectangle } from "../types";
import { packCell, getCellBounds, CELL_OFFSET, CELL_MULTIPLIER } from "./projection";

/**
 * Merge contiguous cells into rectangles for efficient rendering.
 * Uses a Float64Array sort (y-primary, x-secondary) to avoid per-cell object
 * allocation from the old Array.from(cells).map(unpackCell) approach.
 */
export function mergeToRectangles(cells: Set<number>): Rectangle[] {
	if (cells.size === 0) return [];

	// Build a Float64Array with y-first packed values so a plain numeric sort
	// gives the y-primary, x-secondary order the row-scan needs.
	// y-first pack: (y + OFFSET) * MULT + (x + OFFSET)
	const sortArr = new Float64Array(cells.size);
	let i = 0;
	for (const v of cells) {
		const xOff = Math.floor(v / CELL_MULTIPLIER); // (x + OFFSET)
		const yOff = v - xOff * CELL_MULTIPLIER;       // (y + OFFSET)
		sortArr[i++] = yOff * CELL_MULTIPLIER + xOff;
	}
	sortArr.sort(); // numeric ascending → y-primary, x-secondary

	const rectangles: Rectangle[] = [];
	const processed = new Set<number>();

	for (let j = 0; j < sortArr.length; j++) {
		const sv = sortArr[j];
		// Unpack y-first encoding inline (no object allocation)
		const xOff = sv % CELL_MULTIPLIER;
		const yOff = (sv - xOff) / CELL_MULTIPLIER;
		const x = xOff - CELL_OFFSET;
		const y = yOff - CELL_OFFSET;

		const key = packCell(x, y);
		if (processed.has(key)) continue;

		const rect = growRectangle(x, y, cells, processed);
		if (rect) rectangles.push(rect);
	}

	return mergeVerticalRectangles(rectangles);
}

/**
 * Grow a rectangle from a starting cell by scanning right and down.
 * Takes x,y directly to avoid GridCell object allocation.
 */
function growRectangle(
	startX: number,
	startY: number,
	cells: Set<number>,
	processed: Set<number>,
): Rectangle | null {
	const startKey = packCell(startX, startY);
	if (!cells.has(startKey) || processed.has(startKey)) {
		return null;
	}

	// Find the width by scanning right
	let width = 1;
	while (cells.has(packCell(startX + width, startY))) {
		width++;
	}

	// Find the height by scanning down, ensuring all rows have the same width
	let height = 1;
	let canGrowDown = true;

	while (canGrowDown) {
		for (let dx = 0; dx < width; dx++) {
			if (!cells.has(packCell(startX + dx, startY + height))) {
				canGrowDown = false;
				break;
			}
		}
		if (canGrowDown) height++;
	}

	// Mark all cells in this rectangle as processed
	for (let dy = 0; dy < height; dy++) {
		for (let dx = 0; dx < width; dx++) {
			processed.add(packCell(startX + dx, startY + dy));
		}
	}

	return {
		minX: startX,
		minY: startY,
		maxX: startX + width - 1,
		maxY: startY + height - 1,
	};
}

/**
 * Merge vertically adjacent rectangles with the same x-extent
 */
function mergeVerticalRectangles(rectangles: Rectangle[]): Rectangle[] {
	if (rectangles.length === 0) return [];

	// Sort by x, then y
	const sorted = [...rectangles].sort((a, b) => a.minX - b.minX || a.minY - b.minY);

	const merged: Rectangle[] = [];
	let current = sorted[0];

	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];

		// Can merge if same x-extent and vertically adjacent
		if (
			current.minX === next.minX &&
			current.maxX === next.maxX &&
			current.maxY + 1 === next.minY
		) {
			// Merge by extending current
			current = {
				...current,
				maxY: next.maxY,
			};
		} else {
			// Can't merge, save current and move to next
			merged.push(current);
			current = next;
		}
	}

	merged.push(current);
	return merged;
}

/**
 * Fast check if a point is in any rectangle
 */
export function isPointInRectangles(x: number, y: number, rectangles: Rectangle[]): boolean {
	for (const rect of rectangles) {
		if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
			return true;
		}
	}
	return false;
}

/**
 * Get all cells touched by a rectangle
 */
export function rectangleToCells(rect: Rectangle): Set<number> {
	const cells = new Set<number>();
	for (let y = rect.minY; y <= rect.maxY; y++) {
		for (let x = rect.minX; x <= rect.maxX; x++) {
			cells.add(packCell(x, y));
		}
	}
	return cells;
}

/**
 * Compute statistics about grid coverage
 */
export interface GridStats {
	totalCells: number;
	rectangleCount: number;
	averageRectangleSize: number;
	compressionRatio: number;
	bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

export function computeGridStats(cells: Set<number>, rectangles: Rectangle[]): GridStats {
	const bounds = getCellBounds(cells);

	return {
		totalCells: cells.size,
		rectangleCount: rectangles.length,
		averageRectangleSize: cells.size / Math.max(rectangles.length, 1),
		compressionRatio: rectangles.length / Math.max(cells.size, 1),
		bounds,
	};
}
