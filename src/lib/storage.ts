// IndexedDB persistence layer for storing visited cells and processing state
// Enables fast reload without re-processing all activities

import { openDB, type IDBPDatabase } from "idb";
import type { StoredState, ProcessingConfig, StravaActivity } from "../types";

const DB_NAME = "StravaExplorationMap";
const DB_VERSION = 2; // bumped: visitedCells now number[] (packed integers)
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
			upgrade(db, _oldVersion, _newVersion, transaction) {
				// Wipe all state on any schema upgrade — data will recompute from activities
				if (db.objectStoreNames.contains(STORE_NAME)) {
					transaction.objectStore(STORE_NAME).clear();
				} else {
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
	visitedCells: Set<number>,
	processedActivityIds: Set<number>,
	config: ProcessingConfig,
	activities: StravaActivity[] = [],
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
	visitedCells: Set<number>;
	processedActivityIds: Set<number>;
	config: ProcessingConfig;
	activities: StravaActivity[];
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
			visitedCells: new Set<number>(state.visitedCells),
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
	} catch (error) {
		console.error("Failed to clear state from IndexedDB:", error);
		throw error;
	}
}
