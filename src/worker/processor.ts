// Web Worker for processing Strava activities in background thread
// Handles polyline decoding, grid cell marking, and rectangle merging

import polyline from "@mapbox/polyline";
import type {
	WorkerMessage,
	WorkerResponse,
	StravaActivity,
	ProcessingConfig,
	Rectangle,
} from "../types";
import { latLngToMeters, pointToCell, cellKey, samplePolyline } from "../lib/projection";
import { mergeToRectangles } from "../lib/grid";

// Worker state
let visitedCells = new Set<string>();
let processedActivityIds = new Set<number>();
let currentConfig: ProcessingConfig = {
	cellSize: 25,
	samplingStep: 12.5,
	privacyDistance: 100,
	snapToGrid: false,
	skipPrivate: false,
};

/**
 * Process a batch of activities and mark visited cells
 */
function processBatch(
	activities: StravaActivity[],
	config: ProcessingConfig,
): { cellsAdded: number; rectangles: Rectangle[] } {
	let cellsAdded = 0;
	const initialSize = visitedCells.size;

	for (const activity of activities) {
		// Skip if already processed
		if (processedActivityIds.has(activity.id)) continue;

		// Skip private activities if configured
		if (config.skipPrivate && activity.private) continue;

		// Get polyline
		const encodedPolyline = activity.map?.summary_polyline || activity.map?.polyline;
		if (!encodedPolyline) {
			processedActivityIds.add(activity.id);
			continue;
		}

		try {
			// Decode polyline to lat/lng points
			const points = polyline.decode(encodedPolyline) as Array<[number, number]>;

			if (points.length === 0) {
				processedActivityIds.add(activity.id);
				continue;
			}

			// Apply privacy filter to remove start/end points
			const filteredPoints = applyPrivacyFilter(points, config);

			// Sample points along the polyline
			const sampledPoints = samplePolyline(filteredPoints, config.samplingStep);

			// Mark cells
			for (const point of sampledPoints) {
				const cell = pointToCell(point.x, point.y, config.cellSize);
				const key = cellKey(cell.x, cell.y);

				if (!visitedCells.has(key)) {
					visitedCells.add(key);
				}
			}

			processedActivityIds.add(activity.id);
		} catch (error) {
			console.error(`Failed to process activity ${activity.id}:`, error);
			processedActivityIds.add(activity.id); // Mark as processed to avoid retry
		}
	}

	cellsAdded = visitedCells.size - initialSize;

	// Merge cells to rectangles for efficient rendering
	const rectangles = mergeToRectangles(visitedCells);

	return { cellsAdded, rectangles };
}

/**
 * Apply privacy filter to remove start/end points
 */
function applyPrivacyFilter(
	points: Array<[number, number]>,
	config: ProcessingConfig,
): Array<[number, number]> {
	if (config.privacyDistance <= 0 || points.length < 3) {
		return points;
	}

	const filtered: Array<[number, number]> = [];
	let accumulatedStart = 0;
	let accumulatedEnd = 0;

	// Calculate distances from start
	for (let i = 1; i < points.length; i++) {
		const [lat1, lng1] = points[i - 1];
		const [lat2, lng2] = points[i];
		const dist = haversineDistance(lat1, lng1, lat2, lng2);
		accumulatedStart += dist;

		if (accumulatedStart >= config.privacyDistance) {
			// Start including points from here
			for (let j = i; j < points.length; j++) {
				filtered.push(points[j]);
			}
			break;
		}
	}

	if (filtered.length < 3) {
		return []; // Activity too short after privacy filter
	}

	// Calculate distances from end and remove
	const result: Array<[number, number]> = [];
	for (let i = filtered.length - 2; i >= 0; i--) {
		const [lat1, lng1] = filtered[i];
		const [lat2, lng2] = filtered[i + 1];
		const dist = haversineDistance(lat1, lng1, lat2, lng2);
		accumulatedEnd += dist;

		if (accumulatedEnd >= config.privacyDistance) {
			// Keep points up to here
			for (let j = 0; j <= i; j++) {
				result.push(filtered[j]);
			}
			break;
		}
	}

	return result.length >= 2 ? result : [];
}

/**
 * Haversine distance calculation (copied to avoid import issues in worker)
 */
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const EARTH_RADIUS = 6378137;
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
 * Initialize worker with existing state
 */
function initialize(data: {
	visitedCells?: string[];
	processedActivityIds?: number[];
	config?: ProcessingConfig;
}): void {
	if (data.visitedCells) {
		visitedCells = new Set(data.visitedCells);
	}
	if (data.processedActivityIds) {
		processedActivityIds = new Set(data.processedActivityIds);
	}
	if (data.config) {
		currentConfig = data.config;
	}

	const response: WorkerResponse = {
		type: "progress",
		progress: processedActivityIds.size,
		total: processedActivityIds.size,
		data: {
			cellCount: visitedCells.size,
			initialized: true,
		},
	};

	self.postMessage(response);
}

/**
 * Process activities in batches
 */
async function processActivities(data: {
	activities: StravaActivity[];
	batchSize?: number;
}): Promise<void> {
	const { activities, batchSize = 20 } = data;
	const total = activities.length;
	let processed = 0;

	// Filter out already processed activities
	const toProcess = activities.filter((a) => !processedActivityIds.has(a.id));

	// Process in batches
	for (let i = 0; i < toProcess.length; i += batchSize) {
		const batch = toProcess.slice(i, i + batchSize);
		const { cellsAdded, rectangles } = processBatch(batch, currentConfig);

		processed += batch.length;

		// Send progress update
		const response: WorkerResponse = {
			type: "rectangles",
			progress: processedActivityIds.size,
			total,
			data: {
				rectangles,
				cellsAdded,
				totalCells: visitedCells.size,
				visitedCells: Array.from(visitedCells),
				processedActivityIds: Array.from(processedActivityIds),
			},
		};

		self.postMessage(response);

		// Small yield to keep worker responsive
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	// Send completion message
	const rectangles = mergeToRectangles(visitedCells);
	const response: WorkerResponse = {
		type: "complete",
		progress: processedActivityIds.size,
		total,
		data: {
			rectangles,
			totalCells: visitedCells.size,
			visitedCells: Array.from(visitedCells),
			processedActivityIds: Array.from(processedActivityIds),
		},
	};

	self.postMessage(response);
}

/**
 * Update processing configuration
 */
function updateConfig(config: Partial<ProcessingConfig>): void {
	currentConfig = { ...currentConfig, ...config };

	// If cell size or sampling changed, need to reprocess
	const needsReprocess = config.cellSize !== undefined || config.samplingStep !== undefined;

	const response: WorkerResponse = {
		type: "progress",
		data: {
			configUpdated: true,
			needsReprocess,
			config: currentConfig,
		},
	};

	self.postMessage(response);
}

/**
 * Clear all state
 */
function clear(): void {
	visitedCells.clear();
	processedActivityIds.clear();

	const response: WorkerResponse = {
		type: "complete",
		data: {
			cleared: true,
		},
	};

	self.postMessage(response);
}

// Message handler
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const { type, data } = event.data;

	try {
		switch (type) {
			case "init":
				initialize(data);
				break;

			case "process":
				await processActivities(data);
				break;

			case "updateConfig":
				updateConfig(data);
				break;

			case "clear":
				clear();
				break;

			default:
				console.warn("Unknown message type:", type);
		}
	} catch (error) {
		const response: WorkerResponse = {
			type: "error",
			data: {
				message: error instanceof Error ? error.message : "Unknown error",
				error,
			},
		};
		self.postMessage(response);
	}
};

// Export empty object for TypeScript
export {};
