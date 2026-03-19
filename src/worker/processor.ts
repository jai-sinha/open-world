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
import { pointToCell } from "../lib/projection";
import {
	loadWasmModule,
	samplePolylineSync,
	trimPolylineByDistanceSync,
	mergeVisitedToRectanglesSync,
	visitedSetInsert,
	visitedSetClear,
	visitedSetSize,
	visitedSetToStrings,
	visitedSetFromStrings,
} from "../lib/wasm-bridge";

// Worker state
// visitedCells now lives in the WASM heap as an unordered_set<int64_t>.
// Use visitedSet* helpers from wasm-bridge for all operations.
let processedActivityIds = new Set<number>();
// Store processed activities so the worker can re-run processing when configs change (e.g., privacyDistance)
let activityStore = new Map<number, StravaActivity>();
let isReprocessing = false;
let isProcessing = false;
let pendingReprocess = false;

let currentConfig: ProcessingConfig = {
	cellSize: 50,
	samplingStep: 25,
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
	const initialSize = visitedSetSize();

	for (const activity of activities) {
		// Store activity for potential reprocessing later
		activityStore.set(activity.id, activity);

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
			const sampledPoints = samplePolylineSync(filteredPoints, config.samplingStep);

			// Mark cells in WASM visited set — no string keys, no JS Set overhead
			for (const point of sampledPoints) {
				const cell = pointToCell(point.x, point.y, config.cellSize);
				visitedSetInsert(cell.x, cell.y);
			}

			processedActivityIds.add(activity.id);
		} catch (error) {
			console.error(`Failed to process activity ${activity.id}:`, error);
			processedActivityIds.add(activity.id); // Mark as processed to avoid retry
		}
	}

	cellsAdded = visitedSetSize() - initialSize;

	// Merge cells to rectangles — reads directly from WASM set, no JS array copy
	const rectangles = mergeVisitedToRectanglesSync();

	return { cellsAdded, rectangles };
}

/**
 * Apply privacy filter to remove start/end points
 * Delegates to shared `trimPolylineByDistance` in projection utilities.
 */
function applyPrivacyFilter(
	points: Array<[number, number]>,
	config: ProcessingConfig,
): Array<[number, number]> {
	return trimPolylineByDistanceSync(points, config.privacyDistance);
}

/* Haversine helper removed from worker; use shared utilities (trimPolylineByDistance/haversineDistance) from lib/projection instead. */

/**
 * Initialize worker with existing state and load WASM module.
 */
async function initialize(data: {
	visitedCells?: string[];
	processedActivityIds?: number[];
	config?: ProcessingConfig;
	activities?: StravaActivity[];
}): Promise<void> {
	// Load WASM module eagerly so all sync calls are ready before processing begins
	await loadWasmModule();

	if (data.visitedCells && data.visitedCells.length > 0) {
		visitedSetFromStrings(data.visitedCells);
	}
	if (data.processedActivityIds) {
		processedActivityIds = new Set(data.processedActivityIds);
	}
	if (data.config) {
		currentConfig = data.config;
	}

	// If the main thread provided activities (e.g. on load), store them so we can reprocess later
	if (data.activities && data.activities.length > 0) {
		for (const act of data.activities) {
			activityStore.set(act.id, act);
		}
	}

	const response: WorkerResponse = {
		type: "progress",
		progress: processedActivityIds.size,
		total: processedActivityIds.size,
		data: {
			cellCount: visitedSetSize(),
			initialized: true,
			storedActivities: activityStore.size,
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

	// If a reprocessing run is happening we should avoid mixing operations
	if (isReprocessing) {
		const response: WorkerResponse = {
			type: "error",
			data: { message: "Cannot process new activities while reprocessing is in progress" },
		};
		self.postMessage(response);
		return;
	}

	// Mark that we're processing new activities
	isProcessing = true;

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
				totalCells: visitedSetSize(),
				visitedCells: visitedSetToStrings(),
				processedActivityIds: Array.from(processedActivityIds),
			},
		};

		self.postMessage(response);

		// Small yield to keep worker responsive
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	// Send completion message
	const rectangles = mergeVisitedToRectanglesSync();
	const response: WorkerResponse = {
		type: "complete",
		progress: processedActivityIds.size,
		total,
		data: {
			rectangles,
			totalCells: visitedSetSize(),
			visitedCells: visitedSetToStrings(),
			processedActivityIds: Array.from(processedActivityIds),
		},
	};

	self.postMessage(response);

	// Done processing; clear processing flag and trigger any pending reprocess
	isProcessing = false;
	if (pendingReprocess && !isReprocessing) {
		pendingReprocess = false;
		reprocessAllActivities();
	}
}

/**
 * Update processing configuration
 * Will trigger an internal reprocess if the change affects coverage (cellSize, samplingStep, privacyDistance, snapToGrid, skipPrivate)
 * or if a forceReprocess flag is provided.
 */
async function reprocessAllActivities(batchSize: number = 20): Promise<void> {
	if (isReprocessing) return;
	isReprocessing = true;

	// Clear existing cells and processed IDs so we rebuild from stored activities
	visitedSetClear();
	processedActivityIds.clear();

	const allActivities = Array.from(activityStore.values());
	const total = allActivities.length;
	let processed = 0;

	for (let i = 0; i < allActivities.length; i += batchSize) {
		const batch = allActivities.slice(i, i + batchSize);
		const { cellsAdded, rectangles } = processBatch(batch, currentConfig);

		processed += batch.length;

		const response: WorkerResponse = {
			type: "rectangles",
			progress: processedActivityIds.size,
			total,
			data: {
				rectangles,
				cellsAdded,
				totalCells: visitedSetSize(),
				visitedCells: visitedSetToStrings(),
				processedActivityIds: Array.from(processedActivityIds),
				reprocessing: true,
			},
		};

		self.postMessage(response);

		// Yield
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	// Finalize - send complete with rectangles
	const rectangles = mergeVisitedToRectanglesSync();
	const completeResponse: WorkerResponse = {
		type: "complete",
		progress: processedActivityIds.size,
		total,
		data: {
			rectangles,
			totalCells: visitedSetSize(),
			visitedCells: visitedSetToStrings(),
			processedActivityIds: Array.from(processedActivityIds),
			reprocessed: true,
		},
	};

	self.postMessage(completeResponse);
	isReprocessing = false;
}

function updateConfig(config: Partial<ProcessingConfig> & { forceReprocess?: boolean }): void {
	currentConfig = { ...currentConfig, ...config };

	const force = (config as any).forceReprocess === true;

	// Determine whether reprocessing is needed
	const needsReprocess =
		config.cellSize !== undefined ||
		config.samplingStep !== undefined ||
		config.privacyDistance !== undefined ||
		config.snapToGrid !== undefined ||
		config.skipPrivate !== undefined ||
		force;

	const response: WorkerResponse = {
		type: "progress",
		data: {
			configUpdated: true,
			needsReprocess,
			config: currentConfig,
		},
	};

	self.postMessage(response);

	// If reprocessing is required, either queue it or run it immediately
	if (needsReprocess) {
		if (activityStore.size === 0) {
			// Nothing to reprocess yet; inform main thread
			const noActivitiesResponse: WorkerResponse = {
				type: "progress",
				data: {
					message: "No activities stored in worker to reprocess",
					configUpdated: true,
					needsReprocess,
					noActivities: true,
					config: currentConfig,
				},
			};
			self.postMessage(noActivitiesResponse);
			return;
		}

		if (isProcessing) {
			// If we're currently processing incoming activities, queue the reprocess
			pendingReprocess = true;
			const queuedResponse: WorkerResponse = {
				type: "progress",
				data: {
					message: "Reprocess queued until current processing completes",
					configUpdated: true,
					needsReprocess,
					queued: true,
					config: currentConfig,
				},
			};
			self.postMessage(queuedResponse);
			return;
		}

		// Start reprocessing
		reprocessAllActivities();
	}
}

/**
 * Clear all state
 */
function clear(): void {
	visitedSetClear();
	processedActivityIds.clear();
	activityStore.clear();
	isReprocessing = false;
	isProcessing = false;
	pendingReprocess = false;

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
				await initialize(data);
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
