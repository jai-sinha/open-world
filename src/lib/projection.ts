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
export function cellToPoint(cellX: number, cellY: number, cellSize: number): { x: number; y: number } {
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
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/**
 * Calculate distance between two lat/lng points in meters (Haversine)
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
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
  stepMeters: number
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
