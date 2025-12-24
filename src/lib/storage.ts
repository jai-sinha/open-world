// IndexedDB persistence layer for storing visited cells and processing state
// Enables fast reload without re-processing all activities

import { openDB, type IDBPDatabase } from "idb";
import type { StoredState, ProcessingConfig } from "../types";

const DB_NAME = "StravaExplorationMap";
const DB_VERSION = 1;
const STORE_NAME = "explorationState";

interface ExplorationDB {
	explorationState: {
		key: string;
		value: StoredState;
	};
}

let dbPromise: Promise<IDBPDatabase<ExplorationDB>> | null = null;

/**
 * Initialize and open the IndexedDB database
 */
async function getDB(): Promise<IDBPDatabase<ExplorationDB>> {
	if (!dbPromise) {
		dbPromise = openDB<ExplorationDB>(DB_NAME, DB_VERSION, {
			upgrade(db) {
				// Create object store if it doesn't exist
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
				}
			},
		});
	}
	return dbPromise;
}

/**
 * Save exploration state to IndexedDB
 */
export async function saveState(
	visitedCells: Set<string>,
	processedActivityIds: Set<number>,
	config: ProcessingConfig,
	activities: any[] = [],
): Promise<void> {
	try {
		const db = await getDB();
		const state: StoredState = {
			version: DB_VERSION,
			visitedCells: Array.from(visitedCells),
			processedActivityIds: Array.from(processedActivityIds),
			config,
			activities,
			lastSync: Date.now(),
		};

		await db.put(STORE_NAME, state, "current");
	} catch (error) {
		console.error("Failed to save state to IndexedDB:", error);
		throw error;
	}
}

/**
 * Load exploration state from IndexedDB
 */
export async function loadState(): Promise<{
	visitedCells: Set<string>;
	processedActivityIds: Set<number>;
	config: ProcessingConfig;
	activities: any[];
	lastSync: number;
} | null> {
	try {
		const db = await getDB();
		const state = await db.get(STORE_NAME, "current");

		if (!state) {
			return null;
		}

		// Validate version
		if (state.version !== DB_VERSION) {
			console.warn("State version mismatch, clearing old data");
			await clearState();
			return null;
		}

		const activities = state.activities || [];

		return {
			visitedCells: new Set(state.visitedCells),
			processedActivityIds: new Set(state.processedActivityIds),
			config: state.config,
			activities,
			lastSync: state.lastSync,
		};
	} catch (error) {
		console.error("Failed to load state from IndexedDB:", error);
		return null;
	}
}

/**
 * Clear all stored state
 */
export async function clearState(): Promise<void> {
	try {
		const db = await getDB();
		await db.delete(STORE_NAME, "current");
		console.log("State cleared");
	} catch (error) {
		console.error("Failed to clear state from IndexedDB:", error);
		throw error;
	}
}

/**
 * Check if state exists in storage
 */
export async function hasStoredState(): Promise<boolean> {
	try {
		const db = await getDB();
		const state = await db.get(STORE_NAME, "current");
		return state !== undefined;
	} catch (error) {
		console.error("Failed to check stored state:", error);
		return false;
	}
}

/**
 * Get storage statistics
 */
export async function getStorageStats(): Promise<{
	cellCount: number;
	activityCount: number;
	lastSync: number | null;
	estimatedSize: number;
} | null> {
	try {
		const db = await getDB();
		const state = await db.get(STORE_NAME, "current");

		if (!state) {
			return null;
		}

		// Rough estimate of storage size in bytes
		const estimatedSize =
			state.visitedCells.length * 20 + // ~20 bytes per cell key
			state.processedActivityIds.length * 8 + // 8 bytes per ID
			200; // overhead

		return {
			cellCount: state.visitedCells.length,
			activityCount: state.processedActivityIds.length,
			lastSync: state.lastSync,
			estimatedSize,
		};
	} catch (error) {
		console.error("Failed to get storage stats:", error);
		return null;
	}
}

/**
 * Merge new cells into existing state (for incremental updates)
 */
export async function mergeCells(
	newCells: Set<string>,
	newActivityIds: Set<number>,
	activities: any[] = [],
): Promise<void> {
	try {
		const existing = await loadState();

		if (!existing) {
			// No existing state, create new
			await saveState(
				newCells,
				newActivityIds,
				{
					cellSize: 50,
					samplingStep: 25,
					privacyDistance: 0,
					snapToGrid: false,
					skipPrivate: false,
				},
				activities,
			);
			return;
		}

		// Merge sets
		const mergedCells = new Set([...existing.visitedCells, ...newCells]);
		const mergedIds = new Set([...existing.processedActivityIds, ...newActivityIds]);

		await saveState(
			mergedCells,
			mergedIds,
			existing.config,
			activities.length > 0 ? activities : existing.activities,
		);
	} catch (error) {
		console.error("Failed to merge cells:", error);
		throw error;
	}
}

/**
 * Close DB connection
 */
export async function closeDB(): Promise<void> {
	// If no DB was ever opened, nothing to do
	if (!dbPromise) return;

	try {
		const db = await dbPromise;
		db.close();
	} catch (e) {
		// ignore errors during shutdown
	} finally {
		// Reset promise so a subsequent getDB() will reopen cleanly
		dbPromise = null;
	}
}
