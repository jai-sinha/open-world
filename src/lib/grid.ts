// Grid processing utilities for marking visited cells and merging to rectangles
// This is the core algorithm for efficient exploration visualization

import type { GridCell, Rectangle } from "../types";
import { cellKey, parseCellKey } from "./projection";

/**
 * Merge contiguous cells into rectangles for efficient rendering
 * Uses row-scan algorithm with optional vertical merging
 */
export function mergeToRectangles(cells: Set<string>): Rectangle[] {
	if (cells.size === 0) return [];

	// Convert to sorted array of cell coordinates
	const cellCoords: GridCell[] = Array.from(cells).map(parseCellKey);

	// Sort by y, then x for row-scan
	cellCoords.sort((a, b) => a.y - b.y || a.x - b.x);

	const rectangles: Rectangle[] = [];
	const processed = new Set<string>();

	for (const cell of cellCoords) {
		const key = cellKey(cell.x, cell.y);
		if (processed.has(key)) continue;

		// Find the extent of the rectangle starting at this cell
		const rect = growRectangle(cell, cells, processed);
		if (rect) {
			rectangles.push(rect);
		}
	}

	// Optional: merge vertically adjacent rectangles with same x-extent
	return mergeVerticalRectangles(rectangles);
}

/**
 * Grow a rectangle from a starting cell by scanning right and down
 */
function growRectangle(
	start: GridCell,
	cells: Set<string>,
	processed: Set<string>,
): Rectangle | null {
	const startKey = cellKey(start.x, start.y);
	if (!cells.has(startKey) || processed.has(startKey)) {
		return null;
	}

	// Find the width by scanning right
	let width = 1;
	while (cells.has(cellKey(start.x + width, start.y))) {
		width++;
	}

	// Find the height by scanning down, ensuring all rows have the same width
	let height = 1;
	let canGrowDown = true;

	while (canGrowDown) {
		// Check if the next row has all required cells
		for (let dx = 0; dx < width; dx++) {
			if (!cells.has(cellKey(start.x + dx, start.y + height))) {
				canGrowDown = false;
				break;
			}
		}
		if (canGrowDown) {
			height++;
		}
	}

	// Mark all cells in this rectangle as processed
	for (let dy = 0; dy < height; dy++) {
		for (let dx = 0; dx < width; dx++) {
			processed.add(cellKey(start.x + dx, start.y + dy));
		}
	}

	return {
		minX: start.x,
		minY: start.y,
		maxX: start.x + width - 1,
		maxY: start.y + height - 1,
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
export function rectangleToCells(rect: Rectangle): Set<string> {
	const cells = new Set<string>();
	for (let y = rect.minY; y <= rect.maxY; y++) {
		for (let x = rect.minX; x <= rect.maxX; x++) {
			cells.add(cellKey(x, y));
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

export function computeGridStats(cells: Set<string>, rectangles: Rectangle[]): GridStats {
	const bounds = getCellBoundsFromSet(cells);

	return {
		totalCells: cells.size,
		rectangleCount: rectangles.length,
		averageRectangleSize: cells.size / Math.max(rectangles.length, 1),
		compressionRatio: rectangles.length / Math.max(cells.size, 1),
		bounds,
	};
}

function getCellBoundsFromSet(cells: Set<string>): {
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
