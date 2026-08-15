import { openDB, type IDBPDatabase } from "idb";
import type { StoredState, ProcessingConfig, StravaActivity, CachedActivities } from "../types";

const DB_NAME = "StravaExplorationMap";
const DB_VERSION = 3;
const EXPLORATION_STORE = "explorationState";
const ACTIVITIES_STORE = "cachedActivities";

interface ExplorationDB {
	explorationState: {
		key: string;
		value: StoredState;
	};
	cachedActivities: {
		key: string;
		value: CachedActivities;
	};
}

let dbPromise: Promise<IDBPDatabase< ExplorationDB>> | null = null;

async function getDB(): Promise<IDBPDatabase< ExplorationDB>> {
	if (!dbPromise) {
		dbPromise = openDB< ExplorationDB>(DB_NAME, DB_VERSION, {
			upgrade(db, _oldVersion, _newVersion, transaction) {
				if (db.objectStoreNames.contains(EXPLORATION_STORE)) {
					transaction.objectStore(EXPLORATION_STORE).clear();
				} else {
					db.createObjectStore(EXPLORATION_STORE);
				}
				if (db.objectStoreNames.contains(ACTIVITIES_STORE)) {
					transaction.objectStore(ACTIVITIES_STORE).clear();
				} else {
					db.createObjectStore(ACTIVITIES_STORE);
				}
			},
		});
	}
	return dbPromise;
}

export async function saveState(
	visitedCells: Set<number>,
	processedActivityIds: Set<number>,
	config: ProcessingConfig,
): Promise<void> {
	try {
		const db = await getDB();
		const state: StoredState = {
			version: DB_VERSION,
			visitedCells: Array.from(visitedCells),
			processedActivityIds: Array.from(processedActivityIds),
			config,
			lastSync: Date.now(),
		};

		await db.put(EXPLORATION_STORE, state, "current");
	} catch (error) {
		console.error("Failed to save state to IndexedDB:", error);
		throw error;
	}
}

export async function saveActivities(activities: StravaActivity[]): Promise<void> {
	try {
		const db = await getDB();
		const cached: CachedActivities = {
			version: DB_VERSION,
			activities,
			lastSync: Date.now(),
		};
		await db.put(ACTIVITIES_STORE, cached, "current");
	} catch (error) {
		console.error("Failed to save activities:", error);
	}
}

export async function loadState(): Promise<{
	visitedCells: Set<number>;
	processedActivityIds: Set<number>;
	config: ProcessingConfig;
	activities: StravaActivity[];
	lastSync: number;
} | null> {
	try {
		const db = await getDB();
		const state = await db.get(EXPLORATION_STORE, "current");

		if (!state) {
			return null;
		}

		if (state.version !== DB_VERSION) {
			console.warn("State version mismatch, clearing old data");
			await clearState();
			return null;
		}

		let activities: StravaActivity[] = [];
		try {
			const cached = await db.get(ACTIVITIES_STORE, "current");
			if (cached && cached.version === DB_VERSION) {
				activities = cached.activities;
			}
		} catch {
		}

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

export async function clearState(): Promise<void> {
	try {
		const db = await getDB();
		await db.delete(EXPLORATION_STORE, "current");
		await db.delete(ACTIVITIES_STORE, "current");
	} catch (error) {
		console.error("Failed to clear state from IndexedDB:", error);
		throw error;
	}
}
