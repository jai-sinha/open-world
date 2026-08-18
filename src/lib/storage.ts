import { openDB, type IDBPDatabase } from "idb";
import type { StoredState, ProcessingConfig, StravaActivity, CachedActivities, City } from "../types";

const DB_NAME = "StravaExplorationMap";
const DB_VERSION = 4;
const EXPLORATION_STORE = "explorationState";
const ACTIVITIES_STORE = "cachedActivities";
const CITIES_STORE = "savedCities";

interface ExplorationDB {
	explorationState: {
		key: string;
		value: StoredState;
	};
	cachedActivities: {
		key: string;
		value: CachedActivities;
	};
	savedCities: {
		key: string;
		value: { cities: SavedCity[]; stats: import("../types").CityStats[]; lastSync: number };
	};
}

export interface SavedCity {
	id: string;
	osmId: string;
	name: string;
	displayName: string;
	outline: [number, number][][];
	roadCells: number[] | null;
	roadTiles: string;
	center?: { lat: number; lng: number };
}

let dbPromise: Promise<IDBPDatabase< ExplorationDB>> | null = null;

async function getDB(): Promise<IDBPDatabase< ExplorationDB>> {
	if (!dbPromise) {
		dbPromise = openDB< ExplorationDB>(DB_NAME, DB_VERSION, {
			upgrade(db, _oldVersion, _newVersion, transaction) {
				if (_oldVersion < 4) {
					for (const name of db.objectStoreNames) {
						transaction.objectStore(name).clear();
					}
				}

				if (!db.objectStoreNames.contains(EXPLORATION_STORE)) {
					db.createObjectStore(EXPLORATION_STORE);
				}
				if (!db.objectStoreNames.contains(ACTIVITIES_STORE)) {
					db.createObjectStore(ACTIVITIES_STORE);
				}
				if (!db.objectStoreNames.contains(CITIES_STORE)) {
					db.createObjectStore(CITIES_STORE);
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
		await db.delete(CITIES_STORE, "current");
	} catch (error) {
		console.error("Failed to clear state from IndexedDB:", error);
		throw error;
	}

	try {
		const dbs = await indexedDB.databases();
		for (const db of dbs) {
			if (db.name) {
				try { indexedDB.deleteDatabase(db.name); } catch { /* ignore */ }
			}
		}
	} catch (error) {
		console.error("Failed to delete IndexedDB databases:", error);
	}

	try {
		localStorage.removeItem("strava_access_token");
		localStorage.removeItem("strava_refresh_token");
		localStorage.removeItem("strava_expires_at");
		localStorage.removeItem("strava_athlete");
	} catch { /* ignore */ }
}

function serializeCity(city: City): SavedCity {
	return {
		id: city.id,
		osmId: city.osmId,
		name: city.name,
		displayName: city.displayName,
		outline: city.outline,
		roadCells: city.roadCells ? Array.from(city.roadCells) : null,
		roadTiles: city.roadTiles,
		center: city.center,
	};
}

function deserializeCity(saved: SavedCity): City {
	return {
		id: saved.id,
		osmId: saved.osmId,
		name: saved.name,
		displayName: saved.displayName,
		outline: saved.outline,
		roadCells: saved.roadCells ? new Set(saved.roadCells) : null,
		roadTiles: saved.roadTiles,
		center: saved.center,
	};
}

export async function saveCities(
	cities: City[],
	cityStats: import("../types").CityStats[],
): Promise<void> {
	try {
		const db = await getDB();
		await db.put(CITIES_STORE, {
			cities: Array.from(cities).map(serializeCity),
			stats: cityStats,
			lastSync: Date.now(),
		}, "current");
	} catch (error) {
		console.error("Failed to save cities:", error);
	}
}

export async function loadCities(): Promise<{
	cities: City[];
	cityStats: import("../types").CityStats[];
} | null> {
	try {
		const db = await getDB();
		const record = await db.get(CITIES_STORE, "current");
		if (!record) return null;
		return {
			cities: record.cities.map(deserializeCity),
			cityStats: record.stats,
		};
	} catch (error) {
		console.error("Failed to load cities:", error);
		return null;
	}
}
