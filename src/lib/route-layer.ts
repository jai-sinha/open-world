// Route overlay layer for displaying Strava activity polylines on the map

import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { StravaActivity } from "../types";
import polyline from "@mapbox/polyline";
import { trimPolylineByDistance } from "./projection";

export interface RouteLayerOptions {
	lineColor?: string;
	lineWidth?: number;
	lineOpacity?: number;
	showPrivate?: boolean;
	imperialUnits?: boolean;
	privacyDistance?: number;
}

export const ACTIVITY_COLORS: Record<string, string> = {
	Run: "#E53935",
	Ride: "#1E88E5",
	Walk: "#43A047",
	Hike: "#FB8C00",
	Swim: "#00ACC1",
	AlpineSki: "#00897B",
	default: "#fc5200",
};

export class RouteOverlayLayer {
	private map: MapLibreMap;
	private sourceId = "strava-routes";
	private layerId = "strava-routes-layer";
	private activities: StravaActivity[] = [];
	private options: Required<RouteLayerOptions>;
	private visible = true;
	private tooltip: HTMLDivElement | null = null;
	private currentFeatureIds: string = "";

	constructor(map: MapLibreMap, options: RouteLayerOptions = {}) {
		this.map = map;
		this.options = {
			lineColor: "#FF5722",
			lineWidth: 3.5,
			lineOpacity: 0.7,
			showPrivate: false,
			imperialUnits: false,
			privacyDistance: 0,
			...options,
		};
		this.initialize();
	}

	// using tooltips instead of MapLibre's built-in popups for better performance with many features
	private createTooltip(): HTMLDivElement {
		const el = document.createElement("div");
		el.style.cssText = `
			position: fixed;
			pointer-events: none;
			background: white;
			border-radius: 4px;
			padding: 8px 12px;
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			font-size: 12px;
			box-shadow: 0 2px 8px rgba(0,0,0,0.2);
			z-index: 9999;
			max-width: 300px;
			max-height: 300px;
			overflow-y: auto;
			display: none;
		`;
		document.body.appendChild(el);
		return el;
	}

	private initialize(): void {
		this.tooltip = this.createTooltip();

		this.map.addSource(this.sourceId, {
			type: "geojson",
			data: { type: "FeatureCollection", features: [] },
		});

		this.map.addLayer({
			id: this.layerId,
			type: "line",
			source: this.sourceId,
			paint: {
				"line-color": ["get", "color"],
				"line-width": this.options.lineWidth,
				"line-opacity": this.options.lineOpacity,
			},
			layout: {
				"line-cap": "round",
				"line-join": "round",
			},
		});

		this.map.on("mousemove", this.layerId, this.onMouseMove);
		this.map.on("mouseleave", this.layerId, this.onMouseLeave);
	}

	private onMouseMove = (e: any): void => {
		if (!this.tooltip) return;

		// Query all features at this point to get overlapping routes
		const features = this.map.queryRenderedFeatures(e.point, { layers: [this.layerId] });
		if (!features.length) {
			this.tooltip.style.display = "none";
			return;
		}

		this.map.getCanvas().style.cursor = "pointer";

		// Build a key from all feature IDs to detect changes
		const featureIds = features.map((f) => f.properties?.id).join(",");

		// Only update content if the set of features changed
		if (featureIds !== this.currentFeatureIds) {
			this.currentFeatureIds = featureIds;
			this.tooltip.innerHTML = features
				.map((f) => {
					const p = f.properties!;
					return `
								<div style="padding: 4px 0; border-bottom: 1px solid #eee;">
									<div style="font-weight: 600;">${p.name}</div>
									<div style="color: #666;">
										${p.type} · ${this.options.imperialUnits ? (p.distance / 1609.344).toFixed(2) + " mi" : (p.distance / 1000).toFixed(2) + " km"} · ${new Date(p.date).toLocaleDateString()}
									</div>
								</div>
							`;
				})
				.join("");
		}

		// Always update position to follow mouse
		this.tooltip.style.display = "block";
		this.tooltip.style.left = `${e.originalEvent.clientX + 12}px`;
		this.tooltip.style.top = `${e.originalEvent.clientY + 12}px`;
	};

	private onMouseLeave = (): void => {
		this.map.getCanvas().style.cursor = "";
		this.currentFeatureIds = "";
		if (this.tooltip) {
			this.tooltip.style.display = "none";
		}
	};

	private activityToFeature(activity: StravaActivity) {
		const encoded = activity.map?.summary_polyline || activity.map?.polyline;
		if (!encoded) return null;

		try {
			// Decode to [lat, lng] pairs
			const points = polyline.decode(encoded) as Array<[number, number]>;

			// Trim start/end by privacyDistance if configured
			const trimmed =
				this.options.privacyDistance && this.options.privacyDistance > 0
					? trimPolylineByDistance(points, this.options.privacyDistance)
					: points;

			// If trimming removed too much, skip drawing this activity
			if (!trimmed || trimmed.length < 2) return null;

			const coordinates = trimmed.map(([lat, lng]) => [lng, lat]);
			return {
				type: "Feature" as const,
				properties: {
					id: activity.id,
					name: activity.name,
					type: activity.type,
					distance: activity.distance,
					date: activity.start_date,
					color: ACTIVITY_COLORS[activity.type] || ACTIVITY_COLORS.default,
				},
				geometry: { type: "LineString" as const, coordinates },
			};
		} catch {
			return null;
		}
	}

	private updateSource(activities: StravaActivity[]): void {
		const filtered = activities.filter(
			(a) =>
				(this.options.showPrivate || !a.private) && (a.map?.summary_polyline || a.map?.polyline),
		);

		const features = filtered.map((a) => this.activityToFeature(a)).filter(Boolean);
		const source = this.map.getSource(this.sourceId) as GeoJSONSource;
		if (!source) {
			console.error("Route layer source not found:", this.sourceId);
			return;
		}

		source.setData({
			type: "FeatureCollection",
			features: features as any,
		});
	}

	setActivities(activities: StravaActivity[]): void {
		this.activities = activities;

		const activitiesWithPolylines = activities.filter(
			(a) => a.map?.summary_polyline || a.map?.polyline,
		);

		this.updateSource(this.activities);
	}

	addActivities(activities: StravaActivity[]): void {
		const existingIds = new Set(this.activities.map((a) => a.id));
		this.activities.push(...activities.filter((a) => !existingIds.has(a.id)));
		this.updateSource(this.activities);
	}

	clear(): void {
		this.activities = [];
		this.updateSource([]);
	}

	filterByType(types: string[]): void {
		this.updateSource(this.activities.filter((a) => types.includes(a.type)));
	}

	setVisibility(visible: boolean): void {
		this.visible = visible;
		this.map.setLayoutProperty(this.layerId, "visibility", visible ? "visible" : "none");
	}

	setUnits(imperial: boolean): void {
		this.options.imperialUnits = imperial;
	}

	/**
	 * Return whether the layer is configured to use imperial units
	 */
	isImperialUnits(): boolean {
		return this.options.imperialUnits;
	}

	isVisible(): boolean {
		return this.visible;
	}

	setStyle(style: Partial<RouteLayerOptions>): void {
		this.options = { ...this.options, ...style };

		if (style.lineWidth !== undefined) {
			this.map.setPaintProperty(this.layerId, "line-width", style.lineWidth);
		}
		if (style.lineOpacity !== undefined) {
			this.map.setPaintProperty(this.layerId, "line-opacity", style.lineOpacity);
		}
		if (style.showPrivate !== undefined) {
			this.updateSource(this.activities);
		}
		// Support updating privacyDistance through setStyle for convenience
		if (style.privacyDistance !== undefined) {
			this.setPrivacyDistance(style.privacyDistance);
		}
	}

	/**
	 * Update privacy distance (meters) used when trimming route polylines and re-render layer
	 */
	setPrivacyDistance(distance: number): void {
		this.options.privacyDistance = distance;
		this.updateSource(this.activities);
	}

	getActivityCount(): number {
		return this.activities.length;
	}

	remove(): void {
		this.map.off("mousemove", this.layerId, this.onMouseMove);
		this.map.off("mouseleave", this.layerId, this.onMouseLeave);

		if (this.tooltip) {
			this.tooltip.remove();
			this.tooltip = null;
		}

		if (this.map.getLayer(this.layerId)) this.map.removeLayer(this.layerId);
		if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
	}
}

export function createRouteOverlay(
	map: MapLibreMap,
	options?: RouteLayerOptions,
): RouteOverlayLayer {
	return new RouteOverlayLayer(map, options);
}
