// MapLibre canvas custom layer for fast rectangle rendering
// This provides better performance than GeoJSON for large numbers of rectangles

import type { CustomLayerInterface, Map as MapLibreMap, CustomRenderMethod } from "maplibre-gl";
import type { Rectangle } from "../types";
import { cellToPoint, metersToLatLng } from "./projection";

export interface CanvasLayerOptions {
	id: string;
	cellSize: number;
	fillColor?: string;
	fillOpacity?: number;
	borderColor?: string;
	borderWidth?: number;
}

export class ExplorationCanvasLayer implements CustomLayerInterface {
	id: string;
	type: "custom" = "custom";
	renderingMode: "2d" = "2d";

	private rectangles: Rectangle[] = [];
	private cellSize: number;
	private fillColor: string;
	private fillOpacity: number;
	private borderColor: string;
	private borderWidth: number;
	private map?: MapLibreMap;

	constructor(options: CanvasLayerOptions) {
		this.id = options.id;
		this.cellSize = options.cellSize;
		this.fillColor = options.fillColor || "#4CAF50";
		this.fillOpacity = options.fillOpacity ?? 0.3;
		this.borderColor = options.borderColor || "#2E7D32";
		this.borderWidth = options.borderWidth ?? 0;
	}

	/**
	 * Update rectangles to render
	 */
	setRectangles(rectangles: Rectangle[]): void {
		this.rectangles = rectangles;
		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Update rendering style
	 */
	setStyle(options: {
		fillColor?: string;
		fillOpacity?: number;
		borderColor?: string;
		borderWidth?: number;
	}): void {
		if (options.fillColor !== undefined) this.fillColor = options.fillColor;
		if (options.fillOpacity !== undefined) this.fillOpacity = options.fillOpacity;
		if (options.borderColor !== undefined) this.borderColor = options.borderColor;
		if (options.borderWidth !== undefined) this.borderWidth = options.borderWidth;

		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Update cell size (requires re-projection of rectangles)
	 */
	setCellSize(cellSize: number): void {
		this.cellSize = cellSize;
		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Clear all rectangles
	 */
	clear(): void {
		this.rectangles = [];
		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	/**
	 * Get current rectangle count
	 */
	getRectangleCount(): number {
		return this.rectangles.length;
	}

	onAdd(map: MapLibreMap, gl: WebGLRenderingContext): void {
		this.map = map;
	}

	onRemove(): void {
		this.map = undefined;
	}

	render: CustomRenderMethod = (gl, matrix) => {
		// This method is called for WebGL rendering mode
		// We use the 2d rendering mode instead (see below)
	};

	/**
	 * Main render method for 2D canvas
	 */
	prerender?: CustomRenderMethod = (gl, matrix) => {
		// Optional pre-render hook
	};

	/**
	 * Render rectangles on canvas
	 */
	// @ts-ignore - MapLibre types don't include render method for 2d mode
	renderCanvas(ctx: CanvasRenderingContext2D, matrix: Parameters<CustomRenderMethod>[1]): void {
		if (!this.map || this.rectangles.length === 0) return;

		// Set fill style
		const rgb = this.hexToRgb(this.fillColor);
		ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${this.fillOpacity})`;

		if (this.borderWidth > 0) {
			const borderRgb = this.hexToRgb(this.borderColor);
			ctx.strokeStyle = `rgba(${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}, 1)`;
			ctx.lineWidth = this.borderWidth;
		}

		// Render each rectangle
		for (const rect of this.rectangles) {
			this.renderRectangle(ctx, rect);
		}
	}

	/**
	 * Render a single rectangle
	 */
	private renderRectangle(ctx: CanvasRenderingContext2D, rect: Rectangle): void {
		if (!this.map) return;

		// Convert cell coordinates to meter coordinates
		const x1 = rect.minX * this.cellSize;
		const y1 = rect.minY * this.cellSize;
		const x2 = (rect.maxX + 1) * this.cellSize;
		const y2 = (rect.maxY + 1) * this.cellSize;

		// Convert meters to lat/lng
		const sw = metersToLatLng(x1, y1);
		const ne = metersToLatLng(x2, y2);

		// Project to screen coordinates
		const swPoint = this.map.project([sw.lng, sw.lat]);
		const nePoint = this.map.project([ne.lng, ne.lat]);

		const width = nePoint.x - swPoint.x;
		const height = swPoint.y - nePoint.y;

		// Skip if too small to see
		if (width < 0.5 || height < 0.5) return;

		// Draw rectangle
		ctx.fillRect(swPoint.x, nePoint.y, width, height);

		if (this.borderWidth > 0) {
			ctx.strokeRect(swPoint.x, nePoint.y, width, height);
		}
	}

	/**
	 * Convert hex color to RGB
	 */
	private hexToRgb(hex: string): { r: number; g: number; b: number } {
		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		return result
			? {
					r: parseInt(result[1], 16),
					g: parseInt(result[2], 16),
					b: parseInt(result[3], 16),
				}
			: { r: 0, g: 0, b: 0 };
	}
}

/**
 * Create and add exploration layer to map
 */
export function createExplorationLayer(
	map: MapLibreMap,
	options?: Partial<CanvasLayerOptions>,
): ExplorationCanvasLayer {
	const layer = new ExplorationCanvasLayer({
		id: "exploration-layer",
		cellSize: 25,
		fillColor: "#4CAF50",
		fillOpacity: 0.3,
		...options,
	});

	map.addLayer(layer);
	return layer;
}
