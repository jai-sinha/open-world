import { latLngToMeters, pointToCell, packCell, unpackCell } from "./projection";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { PMTiles } from "pmtiles";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

// Configure this at runtime via setRoadPMTilesURL()
let PMTILES_URL = "";
let globalPmtiles: PMTiles | null = null;

export function setRoadPMTilesURL(url: string) {
	if (PMTILES_URL === url) return;
	PMTILES_URL = url;
	globalPmtiles = url ? new PMTiles(url) : null;
}

interface RoadCellsDB extends DBSchema {
	// Cache final road cells by tile z/x/y and cellSize (better reuse across cities)
	roadTileCells: {
		key: string; // `${z}/${x}/${y}/${cellSize}`
		value: {
			key: string;
			cells: Int32Array; // interleaved x,y pairs of packed integer cells
			timestamp: number;
		};
		indexes: {
			timestamp: number;
		};
	};
}

let db: IDBPDatabase<RoadCellsDB> | null = null;
async function getDb(): Promise<IDBPDatabase<RoadCellsDB>> {
	if (db) return db;
	db = await openDB<RoadCellsDB>("open-world", 4, {
		upgrade(db, _oldVersion, _newVersion, transaction) {
			// Wipe on any upgrade — cells format changed to Int32Array
			if (db.objectStoreNames.contains("roadTileCells")) {
				transaction.objectStore("roadTileCells").clear();
			} else {
				const store = db.createObjectStore("roadTileCells", { keyPath: "key" });
				store.createIndex("timestamp", "timestamp");
			}
		},
	});
	return db;
}

function tileKey(z: number, x: number, y: number, cellSize: number): string {
	return `${z}/${x}/${y}/${cellSize}`;
}

// WebMercator helpers for tile math
export function latLngToTile(lat: number, lng: number, z: number): { x: number; y: number } {
	const n = 2 ** z;
	const xtile = Math.floor(((lng + 180) / 360) * n);
	const ytile = Math.floor(
		((1 -
			Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
			2) *
			n,
	);
	return { x: xtile, y: ytile };
}

function coverTilesForBbox(
	minLat: number,
	maxLat: number,
	minLng: number,
	maxLng: number,
	z: number,
) {
	const t1 = latLngToTile(minLat, minLng, z);
	const t2 = latLngToTile(maxLat, maxLng, z);
	const minX = Math.min(t1.x, t2.x);
	const maxX = Math.max(t1.x, t2.x);
	const minY = Math.min(t1.y, t2.y);
	const maxY = Math.max(t1.y, t2.y);
	const tiles: Array<{ z: number; x: number; y: number }> = [];
	for (let x = minX; x <= maxX; x++) {
		for (let y = minY; y <= maxY; y++) tiles.push({ z, x, y });
	}
	return tiles;
}

async function getCachedTileCells(
	z: number,
	x: number,
	y: number,
	cellSize: number,
): Promise<Set<number> | null> {
	try {
		const db = await getDb();
		const rec = await db.get("roadTileCells", tileKey(z, x, y, cellSize));
		if (rec) {
			updateTimestamp(rec.key, rec.cells).catch(console.warn);
			const cells = new Set<number>();
			for (let i = 0; i < rec.cells.length; i += 2) {
				cells.add(packCell(rec.cells[i], rec.cells[i + 1]));
			}
			return cells;
		}
	} catch (e) {
		console.warn("Failed to read tile cells from cache:", e);
	}
	return null;
}

async function updateTimestamp(key: string, cells: Int32Array) {
	try {
		const db = await getDb();
		await db.put("roadTileCells", {
			key,
			cells,
			timestamp: Date.now(),
		});
	} catch {
		// Ignore write errors for timestamp updates
	}
}

// Keep cache size under control (e.g. 500 tiles ~ 20-50MB depending on density)
const MAX_CACHE_SIZE = 500;
let pruneInProgress = false;

async function pruneCache() {
	if (pruneInProgress) return;
	pruneInProgress = true;
	try {
		const db = await getDb();
		const count = await db.count("roadTileCells");
		if (count > MAX_CACHE_SIZE) {
			const deleteCount = count - MAX_CACHE_SIZE;
			// Delete oldest entries
			let deleted = 0;
			let cursor = await db
				.transaction("roadTileCells", "readwrite")
				.store.index("timestamp")
				.openCursor();

			while (cursor && deleted < deleteCount) {
				await cursor.delete();
				deleted++;
				cursor = await cursor.continue();
			}
		}
	} catch (e) {
		console.warn("Cache pruning failed:", e);
	} finally {
		pruneInProgress = false;
	}
}

async function cacheTileCells(
	z: number,
	x: number,
	y: number,
	cellSize: number,
	cells: Set<number>,
): Promise<void> {
	try {
		const db = await getDb();
		const arr = new Int32Array(cells.size * 2);
		let i = 0;
		for (const v of cells) {
			const { x: cx, y: cy } = unpackCell(v);
			arr[i++] = cx;
			arr[i++] = cy;
		}
		await db.put("roadTileCells", {
			key: tileKey(z, x, y, cellSize),
			cells: arr,
			timestamp: Date.now(),
		});
		pruneCache().catch(console.warn);
	} catch (e) {
		console.warn("Failed to cache tile cells:", e);
	}
}

async function fetchTileBytes(
	z: number,
	x: number,
	y: number,
	pmtilesInstance: PMTiles | null,
): Promise<ArrayBuffer | null> {
	const target = pmtilesInstance || globalPmtiles;
	if (!target) {
		console.warn("PMTiles source not configured");
		return null;
	}

	try {
		const resp = await target.getZxy(z, x, y);
		if (!resp || !resp.data) return null;
		return resp.data as ArrayBuffer;
	} catch (e) {
		console.warn(`PMTiles fetch failed for ${z}/${x}/${y}:`, e);
		return null;
	}
}

// Rasterize a line segment into grid cells (reused from viewport logic)
function rasterizeLineToRoadCells(
	lng1: number,
	lat1: number,
	lng2: number,
	lat2: number,
	cellSize: number,
): Set<number> {
	const cells = new Set<number>();
	const p1 = latLngToMeters(lat1, lng1);
	const p2 = latLngToMeters(lat2, lng2);
	const dx = p2.x - p1.x;
	const dy = p2.y - p1.y;
	const dist = Math.sqrt(dx * dx + dy * dy);
	const steps = Math.ceil(dist / (cellSize / 2));
	for (let s = 0; s <= steps; s++) {
		const t = steps === 0 ? 0 : s / steps;
		const x = p1.x + dx * t;
		const y = p1.y + dy * t;
		const cell = pointToCell(x, y, cellSize);
		cells.add(packCell(cell.x, cell.y));
	}
	return cells;
}

export async function getRoadCellsForBbox(
	minLat: number,
	maxLat: number,
	minLng: number,
	maxLng: number,
	cellSize: number,
	zoom = 14,
	useCache = true,
	pmtilesInstance?: PMTiles | null,
): Promise<Set<number>> {
	// If no instance provided and no global set, we can't do anything.
	if (!pmtilesInstance && !globalPmtiles) {
		console.warn("PMTiles not configured; call setRoadPMTilesURL() or pass instance");
		return new Set();
	}

	// Assemble from tile-level caches, then filter to bbox
	const tiles = coverTilesForBbox(minLat, maxLat, minLng, maxLng, zoom);
	const union = new Set<number>();

	// Process tiles in parallel with concurrency limit
	const CONCURRENCY = 24;
	const queue = [...tiles];

	const processTile = async (z: number, x: number, y: number) => {
		let tileCells = useCache ? await getCachedTileCells(z, x, y, cellSize) : null;

		if (!tileCells) {
			const bytes = await fetchTileBytes(z, x, y, pmtilesInstance || null);
			if (!bytes) return;
			try {
				const vt = new VectorTile(new Pbf(new Uint8Array(bytes)));
				const layerNames = Object.keys(vt.layers || {});
				const roadLike = layerNames.find((n) => /road|transportation/i.test(n));
				const cells = new Set<number>();
				if (roadLike) {
					const layer = vt.layers[roadLike];
					for (let i = 0; i < layer.length; i++) {
						const feature = layer.feature(i);
						const gj = feature.toGeoJSON(x, y, z);
						if (gj.geometry.type === "LineString") {
							const coords = gj.geometry.coordinates as [number, number][];
							for (let i = 0; i < coords.length - 1; i++) {
								const [lng1, lat1] = coords[i];
								const [lng2, lat2] = coords[i + 1];
								rasterizeLineToRoadCells(lng1, lat1, lng2, lat2, cellSize).forEach((c) =>
									cells.add(c),
								);
							}
						} else if (gj.geometry.type === "MultiLineString") {
							const lines = gj.geometry.coordinates as [number, number][][];
							for (const line of lines) {
								for (let i = 0; i < line.length - 1; i++) {
									const [lng1, lat1] = line[i];
									const [lng2, lat2] = line[i + 1];
									rasterizeLineToRoadCells(lng1, lat1, lng2, lat2, cellSize).forEach((c) =>
										cells.add(c),
									);
								}
							}
						}
					}
				}
				tileCells = cells;
				if (useCache) {
					await cacheTileCells(z, x, y, cellSize, tileCells);
				}
			} catch (e) {
				console.warn(`Failed to decode vector tile ${z}/${x}/${y}:`, e);
			}
		}
		if (tileCells) {
			for (const c of tileCells) union.add(c);
		}
	};

	const workers = Array(Math.min(tiles.length, CONCURRENCY))
		.fill(null)
		.map(async () => {
			while (queue.length > 0) {
				// Yield to main thread to improve INP
				await new Promise((resolve) => setTimeout(resolve, 0));
				const tile = queue.shift();
				if (tile) await processTile(tile.z, tile.x, tile.y);
			}
		});

	await Promise.all(workers);

	// Filter by bbox
	const sw = latLngToMeters(minLat, minLng);
	const ne = latLngToMeters(maxLat, maxLng);
	const minX = Math.min(sw.x, ne.x);
	const maxX = Math.max(sw.x, ne.x);
	const minY = Math.min(sw.y, ne.y);
	const maxY = Math.max(sw.y, ne.y);
	const filtered = new Set<number>();
	for (const v of union) {
		const { x: sx, y: sy } = unpackCell(v);
		const cx = sx * cellSize + cellSize / 2;
		const cy = sy * cellSize + cellSize / 2;
		if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) filtered.add(v);
	}
	return filtered;
}
