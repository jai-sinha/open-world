import { latLngToMeters, pointToCell, cellKey } from "./projection";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { PMTiles } from "pmtiles";
import Pbf from "pbf";
import { VectorTile } from "@mapbox/vector-tile";

// Configure this at runtime via setRoadPMTilesURL()
let PMTILES_URL = "";
let pmtiles: PMTiles | null = null;

// Circuit breaker state
let failureCount = 0;
const MAX_FAILURES = 5;
let circuitOpen = false;

export function setRoadPMTilesURL(url: string) {
	if (PMTILES_URL === url) return;
	PMTILES_URL = url;
	pmtiles = url ? new PMTiles(url) : null;
	// Reset circuit breaker when URL changes
	failureCount = 0;
	circuitOpen = false;
}

interface RoadCellsDB extends DBSchema {
	// Cache final road cells by tile z/x/y and cellSize (better reuse across cities)
	roadTileCells: {
		key: string; // `${z}/${x}/${y}/${cellSize}`
		value: {
			key: string;
			cells: string[];
			timestamp: number;
		};
	};
}

let db: IDBPDatabase<RoadCellsDB> | null = null;
async function getDb(): Promise<IDBPDatabase<RoadCellsDB>> {
	if (db) return db;
	db = await openDB<RoadCellsDB>("open-world", 2, {
		upgrade(db) {
			if (!db.objectStoreNames.contains("roadTileCells")) {
				db.createObjectStore("roadTileCells", { keyPath: "key" });
			}
		},
	});
	return db;
}

function tileKey(z: number, x: number, y: number, cellSize: number): string {
	return `${z}/${x}/${y}/${cellSize}`;
}

// WebMercator helpers for tile math
function latLngToTile(lat: number, lng: number, z: number): { x: number; y: number } {
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
): Promise<Set<string> | null> {
	try {
		const db = await getDb();
		const rec = await db.get("roadTileCells", tileKey(z, x, y, cellSize));
		if (rec) return new Set(rec.cells);
	} catch (e) {
		console.warn("Failed to read tile cells from cache:", e);
	}
	return null;
}

async function cacheTileCells(
	z: number,
	x: number,
	y: number,
	cellSize: number,
	cells: Set<string>,
): Promise<void> {
	try {
		const db = await getDb();
		await db.put("roadTileCells", {
			key: tileKey(z, x, y, cellSize),
			cells: Array.from(cells),
			timestamp: Date.now(),
		});
	} catch (e) {
		console.warn("Failed to cache tile cells:", e);
	}
}

async function fetchTileBytes(z: number, x: number, y: number): Promise<ArrayBuffer | null> {
	if (!pmtiles) {
		console.warn("PMTiles URL not configured");
		return null;
	}
	if (circuitOpen) return null;

	try {
		const resp = await pmtiles.getZxy(z, x, y);
		failureCount = 0; // Reset on success
		if (!resp || !resp.data) return null;
		return resp.data as ArrayBuffer;
	} catch (e) {
		console.warn(`PMTiles fetch failed for ${z}/${x}/${y}:`, e);
		failureCount++;
		if (failureCount >= MAX_FAILURES) {
			console.warn("Too many PMTiles failures, opening circuit breaker to prevent spam.");
			circuitOpen = true;
		}
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
): Set<string> {
	const cells = new Set<string>();
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
		cells.add(cellKey(cell.x, cell.y));
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
): Promise<Set<string>> {
	if (!pmtiles) {
		console.warn("PMTiles not configured; call setRoadPMTilesURL()");
		return new Set();
	}
	// Assemble from tile-level caches, then filter to bbox
	const tiles = coverTilesForBbox(minLat, maxLat, minLng, maxLng, zoom);
	const union = new Set<string>();

	// Process tiles in parallel with concurrency limit
	const CONCURRENCY = 32;
	const queue = [...tiles];

	const processTile = async (z: number, x: number, y: number) => {
		let tileCells = await getCachedTileCells(z, x, y, cellSize);
		if (!tileCells) {
			const bytes = await fetchTileBytes(z, x, y);
			if (!bytes) return;
			try {
				const vt = new VectorTile(new Pbf(new Uint8Array(bytes)));
				const layerNames = Object.keys(vt.layers || {});
				const roadLike = layerNames.find((n) => /road|transportation/i.test(n));
				const cells = new Set<string>();
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
				await cacheTileCells(z, x, y, cellSize, tileCells);
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
	const filtered = new Set<string>();
	for (const key of union) {
		const [sx, sy] = key.split(",").map(Number);
		const cx = sx * cellSize + cellSize / 2;
		const cy = sy * cellSize + cellSize / 2;
		if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) filtered.add(key);
	}
	return filtered;
}
