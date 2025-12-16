// Route overlay layer for displaying Strava activity polylines on the map
// Provides visualization of actual routes alongside the exploration grid

import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { StravaActivity } from "../types";
import polyline from "@mapbox/polyline";

export interface RouteLayerOptions {
  lineColor?: string;
  lineWidth?: number;
  lineOpacity?: number;
  colorByType?: boolean;
  showPrivate?: boolean;
}

export interface RouteStyle {
  color: string;
  width: number;
  opacity: number;
}

// Activity type color mapping
const ACTIVITY_COLORS: Record<string, string> = {
  Run: "#E53935",
  Ride: "#1E88E5",
  Walk: "#43A047",
  Hike: "#FB8C00",
  Swim: "#00ACC1",
  VirtualRide: "#5E35B1",
  VirtualRun: "#D81B60",
  NordicSki: "#3949AB",
  AlpineSki: "#00897B",
  default: "#546E7A",
};

export class RouteOverlayLayer {
  private map: MapLibreMap;
  private sourceId: string = "strava-routes";
  private layerId: string = "strava-routes-layer";
  private activities: StravaActivity[] = [];
  private options: RouteLayerOptions;
  private visible: boolean = true;

  constructor(map: MapLibreMap, options: RouteLayerOptions = {}) {
    this.map = map;
    this.options = {
      lineColor: "#FF5722",
      lineWidth: 2,
      lineOpacity: 0.7,
      colorByType: true,
      showPrivate: false,
      ...options,
    };

    this.initialize();
  }

  /**
   * Initialize the map source and layer
   */
  private initialize(): void {
    // Add GeoJSON source
    this.map.addSource(this.sourceId, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });

    // Add line layer with conditional coloring
    if (this.options.colorByType) {
      this.map.addLayer({
        id: this.layerId,
        type: "line",
        source: this.sourceId,
        paint: {
          "line-color": ["get", "color"],
          "line-width": this.options.lineWidth ?? 2,
          "line-opacity": this.options.lineOpacity ?? 0.7,
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
      });
    } else {
      this.map.addLayer({
        id: this.layerId,
        type: "line",
        source: this.sourceId,
        paint: {
          "line-color": this.options.lineColor ?? "#FF5722",
          "line-width": this.options.lineWidth ?? 2,
          "line-opacity": this.options.lineOpacity ?? 0.7,
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
      });
    }

    // Add click handler for route details
    this.map.on("click", this.layerId, this.handleRouteClick.bind(this));
    this.map.on("mouseenter", this.layerId, () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", this.layerId, () => {
      this.map.getCanvas().style.cursor = "";
    });
  }

  /**
   * Handle click on a route
   */
  private handleRouteClick(e: any): void {
    if (!e.features || e.features.length === 0) return;

    const feature = e.features[0];
    const props = feature.properties;

    // Create popup with activity details
    const popup = new (window as any).maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(
        `
        <div style="font-family: sans-serif; min-width: 200px;">
          <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600;">${props.name}</h3>
          <div style="font-size: 12px; color: #666;">
            <div><strong>Type:</strong> ${props.type}</div>
            <div><strong>Distance:</strong> ${(props.distance / 1000).toFixed(2)} km</div>
            <div><strong>Date:</strong> ${new Date(props.date).toLocaleDateString()}</div>
          </div>
        </div>
      `
      )
      .addTo(this.map);
  }

  /**
   * Set activities to display
   */
  setActivities(activities: StravaActivity[]): void {
    this.activities = activities;
    this.updateLayer();
  }

  /**
   * Add activities to existing set
   */
  addActivities(activities: StravaActivity[]): void {
    const existingIds = new Set(this.activities.map((a) => a.id));
    const newActivities = activities.filter((a) => !existingIds.has(a.id));
    this.activities.push(...newActivities);
    this.updateLayer();
  }

  /**
   * Clear all activities
   */
  clear(): void {
    this.activities = [];
    this.updateLayer();
  }

  /**
   * Update the GeoJSON source with current activities
   */
  private updateLayer(): void {
    const features = this.activities
      .filter((activity) => {
        // Filter private activities if needed
        if (!this.options.showPrivate && activity.private) {
          return false;
        }
        // Must have polyline data
        return activity.map?.summary_polyline || activity.map?.polyline;
      })
      .map((activity) => {
        const encodedPolyline =
          activity.map?.summary_polyline || activity.map?.polyline;
        if (!encodedPolyline) return null;

        try {
          const coordinates = polyline
            .decode(encodedPolyline)
            .map((point: [number, number]) => [point[1], point[0]]); // [lng, lat]

          const color = this.options.colorByType
            ? ACTIVITY_COLORS[activity.type] || ACTIVITY_COLORS.default
            : this.options.lineColor;

          return {
            type: "Feature" as const,
            properties: {
              id: activity.id,
              name: activity.name,
              type: activity.type,
              distance: activity.distance,
              date: activity.start_date,
              color: color,
              private: activity.private || false,
            },
            geometry: {
              type: "LineString" as const,
              coordinates,
            },
          };
        } catch (error) {
          console.warn(`Failed to decode polyline for activity ${activity.id}:`, error);
          return null;
        }
      })
      .filter((feature) => feature !== null);

    const source = this.map.getSource(this.sourceId) as GeoJSONSource;
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: features as any,
      });
    }
  }

  /**
   * Toggle layer visibility
   */
  toggleVisibility(): void {
    this.visible = !this.visible;
    this.map.setLayoutProperty(
      this.layerId,
      "visibility",
      this.visible ? "visible" : "none"
    );
  }

  /**
   * Set layer visibility explicitly
   */
  setVisibility(visible: boolean): void {
    this.visible = visible;
    this.map.setLayoutProperty(
      this.layerId,
      "visibility",
      visible ? "visible" : "none"
    );
  }

  /**
   * Get current visibility state
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Update layer style
   */
  setStyle(style: Partial<RouteLayerOptions>): void {
    this.options = { ...this.options, ...style };

    if (style.lineColor && !this.options.colorByType) {
      this.map.setPaintProperty(this.layerId, "line-color", style.lineColor);
    }
    if (style.lineWidth !== undefined) {
      this.map.setPaintProperty(this.layerId, "line-width", style.lineWidth);
    }
    if (style.lineOpacity !== undefined) {
      this.map.setPaintProperty(this.layerId, "line-opacity", style.lineOpacity);
    }

    // If colorByType changed, need to recreate layer
    if (style.colorByType !== undefined) {
      this.removeLayer();
      this.initialize();
      this.updateLayer();
    }

    // If showPrivate changed, update displayed routes
    if (style.showPrivate !== undefined) {
      this.updateLayer();
    }
  }

  /**
   * Get activity count
   */
  getActivityCount(): number {
    return this.activities.length;
  }

  /**
   * Filter activities by type
   */
  filterByType(types: string[]): void {
    const filteredActivities = this.activities.filter((activity) =>
      types.includes(activity.type)
    );
    const features = filteredActivities
      .filter((activity) => activity.map?.summary_polyline || activity.map?.polyline)
      .map((activity) => {
        const encodedPolyline =
          activity.map?.summary_polyline || activity.map?.polyline;
        if (!encodedPolyline) return null;

        try {
          const coordinates = polyline
            .decode(encodedPolyline)
            .map((point: [number, number]) => [point[1], point[0]]);

          const color = this.options.colorByType
            ? ACTIVITY_COLORS[activity.type] || ACTIVITY_COLORS.default
            : this.options.lineColor;

          return {
            type: "Feature" as const,
            properties: {
              id: activity.id,
              name: activity.name,
              type: activity.type,
              distance: activity.distance,
              date: activity.start_date,
              color: color,
            },
            geometry: {
              type: "LineString" as const,
              coordinates,
            },
          };
        } catch (error) {
          return null;
        }
      })
      .filter((feature) => feature !== null);

    const source = this.map.getSource(this.sourceId) as GeoJSONSource;
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: features as any,
      });
    }
  }

  /**
   * Remove the layer and source
   */
  remove(): void {
    this.removeLayer();
  }

  /**
   * Helper to remove layer and source
   */
  private removeLayer(): void {
    if (this.map.getLayer(this.layerId)) {
      this.map.off("click", this.layerId, this.handleRouteClick.bind(this));
      this.map.off("mouseenter", this.layerId, () => {});
      this.map.off("mouseleave", this.layerId, () => {});
      this.map.removeLayer(this.layerId);
    }
    if (this.map.getSource(this.sourceId)) {
      this.map.removeSource(this.sourceId);
    }
  }
}

/**
 * Create and initialize a route overlay layer
 */
export function createRouteOverlay(
  map: MapLibreMap,
  options?: RouteLayerOptions
): RouteOverlayLayer {
  return new RouteOverlayLayer(map, options);
}
