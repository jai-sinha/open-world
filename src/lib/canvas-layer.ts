// MapLibre canvas custom layer for fast rectangle rendering
// This provides better performance than GeoJSON for large numbers of rectangles

import type { CustomLayerInterface, Map as MapLibreMap, CustomRenderMethod } from "maplibre-gl";
import type { Rectangle } from "../types";
import { metersToLatLng, CELL_SIZE } from "./projection";

export interface CanvasLayerOptions {
	id: string;
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
	private fillColor: string;
	private fillOpacity: number;
	private borderColor: string;
	private borderWidth: number;
	private map?: MapLibreMap;

	constructor(options: CanvasLayerOptions) {
		this.id = options.id;
		this.fillColor = options.fillColor || "#4CAF50";
		this.fillOpacity = options.fillOpacity ?? 0.3;
		this.borderColor = options.borderColor || "#2E7D32";
		this.borderWidth = options.borderWidth ?? 0;
	}

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
	 * Clear all rectangles
	 */
	clear(): void {
		this.rectangles = [];
		if (this.map) {
			this.map.triggerRepaint();
		}
	}

	onAdd(map: MapLibreMap, _gl: WebGLRenderingContext): void {
		this.map = map;
	}

	onRemove(): void {
		this.map = undefined;
	}

	// these two are necessary for CustomLayerInterface implementation
	render: CustomRenderMethod = (_gl, _matrix) => {
	};
	prerender?: CustomRenderMethod = (_gl, _matrix) => {
	};

	/**
	 * Render rectangles on canvas.
	 *
	 * Uses a linear approximation for cell→screen projection:
	 * projects 3 reference points once, then derives all rectangle
	 * positions arithmetically — avoids 2× map.project() per rect.
	 */
	// @ts-ignore - MapLibre types don't include render method for 2d mode
	renderCanvas(ctx: CanvasRenderingContext2D, _matrix: Parameters<CustomRenderMethod>[1]): void {
		if (!this.map || this.rectangles.length === 0) return;

		const rgb = this.hexToRgb(this.fillColor);
		ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${this.fillOpacity})`;

		if (this.borderWidth > 0) {
			const borderRgb = this.hexToRgb(this.borderColor);
			ctx.strokeStyle = `rgba(${borderRgb.r}, ${borderRgb.g}, ${borderRgb.b}, 1)`;
			ctx.lineWidth = this.borderWidth;
		}

		// Project reference points to derive screen-space cell dimensions.
		// 3 calls total regardless of rectangle count.
		const p0 = projectMeters(this.map, 0, 0);
		const pE = projectMeters(this.map, CELL_SIZE, 0);
		const pN = projectMeters(this.map, 0, CELL_SIZE);

		const dx = pE.x - p0.x;
		const dy = p0.y - pN.y;

		for (const rect of this.rectangles) {
			const cellW = rect.maxX - rect.minX + 1;
			const cellH = rect.maxY - rect.minY + 1;
			const x = p0.x + rect.minX * dx;
			const y = p0.y - rect.minY * dy;
			const w = cellW * dx;
			const h = cellH * dy;

			if (w < 0.5 || h < 0.5) continue;

			ctx.fillRect(x, y, w, h);

			if (this.borderWidth > 0) {
				ctx.strokeRect(x, y, w, h);
			}
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
 * Project Web Mercator meters to screen pixels via a single map.project call.
 */
function projectMeters(map: MapLibreMap, x: number, y: number): { x: number; y: number } {
	const ll = metersToLatLng(x, y);
	return map.project([ll.lng, ll.lat]);
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
		fillColor: "#4CAF50",
		fillOpacity: 0.3,
		...options,
	});

	map.addLayer(layer);
	return layer;
}
