// Loads the compiled WASM module and exposes its functions to TypeScript.
// All hot-path calls from processor.ts and stats.ts will go through here.

// Emscripten module type (grows as we add exports)
interface CoreModule {
  cwrap: (name: string, ret: string, args: string[]) => (...args: unknown[]) => unknown;
  // Scalar functions
  _hello: () => number;
  _haversine_distance: (lat1: number, lng1: number, lat2: number, lng2: number) => number;
  _point_to_cell: (x: number, y: number, cellSize: number, outCxPtr: number, outCyPtr: number) => void;
  // Output buffer accessors (return WASM heap byte offset)
  _get_f64_out_buf: () => number;
  _get_i32_out_buf: () => number;
  // Array functions (write to output buffer, return element count)
  _sample_polyline: (latlngPtr: number, nPoints: number, stepMeters: number) => number;
  _trim_polyline_by_distance: (latlngPtr: number, nPoints: number, distMeters: number) => number;
  _merge_to_rectangles: (cellsPtr: number, nCells: number) => number;
  // Persistent visited set
  _visited_set_insert: (cx: number, cy: number) => number;
  _visited_set_has: (cx: number, cy: number) => number;
  _visited_set_clear: () => void;
  _visited_set_size: () => number;
  _visited_set_to_array: () => number;
  _get_visited_dump_buf: () => number;
  _merge_visited_to_rectangles: () => number;
  // Fuzzy visited count
  _count_visited_fuzzy: (targetPtr: number, nTarget: number, visitedPtr: number, nVisited: number) => number;
  _count_visited_fuzzy_vs_set: (targetPtr: number, nTarget: number) => number;
  // WASM heap views
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  HEAPU8: Uint8Array;
  // Memory management
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
}

let _module: CoreModule | null = null;

export async function loadWasmModule(): Promise<CoreModule> {
  if (_module) return _module;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory = (await import(/* @vite-ignore */ "/wasm/core.js" as any)).default as (
    opts?: object,
  ) => Promise<CoreModule>;
  _module = await factory();
  return _module;
}

// Sanity-check — call on worker init to confirm the module loaded correctly.
export async function verifyWasm(): Promise<void> {
  const mod = await loadWasmModule();
  const result = mod._hello();
  if (result !== 42) {
    throw new Error(`WASM sanity check failed: hello() returned ${result}, expected 42`);
  }
}

// ---------------------------------------------------------------------------
// Helpers for passing typed arrays across the JS/WASM boundary.
// We allocate a buffer in WASM heap, copy into it, call the function, then
// read the output buffer and free. All allocations are short-lived.
// ---------------------------------------------------------------------------

// Write a Float64Array into WASM heap; returns the WASM pointer.
function mallocF64(mod: CoreModule, data: Float64Array): number {
  const ptr = mod._malloc(data.byteLength);
  mod.HEAPF64.set(data, ptr >> 3);
  return ptr;
}

// Read n float64 pairs from the shared output buffer into a new Float64Array.
function readF64Out(mod: CoreModule, count: number): Float64Array {
  const base = mod._get_f64_out_buf() >> 3;
  return mod.HEAPF64.slice(base, base + count * 2);
}

// ---------------------------------------------------------------------------
// Public API — mirrors the TypeScript functions in projection.ts
// ---------------------------------------------------------------------------

export async function samplePolyline(
  points: Array<[number, number]>, // [lat, lng]
  stepMeters: number,
): Promise<Array<{ x: number; y: number }>> {
  const mod = await loadWasmModule();
  const flat = new Float64Array(points.flatMap(([lat, lng]) => [lat, lng]));
  const ptr = mallocF64(mod, flat);
  const count = mod._sample_polyline(ptr, points.length, stepMeters);
  mod._free(ptr);
  const out = readF64Out(mod, count);
  const result: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) result.push({ x: out[i * 2], y: out[i * 2 + 1] });
  return result;
}

export async function trimPolylineByDistance(
  points: Array<[number, number]>, // [lat, lng]
  distMeters: number,
): Promise<Array<[number, number]>> {
  const mod = await loadWasmModule();
  const flat = new Float64Array(points.flatMap(([lat, lng]) => [lat, lng]));
  const ptr = mallocF64(mod, flat);
  const count = mod._trim_polyline_by_distance(ptr, points.length, distMeters);
  mod._free(ptr);
  const out = readF64Out(mod, count);
  const result: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) result.push([out[i * 2], out[i * 2 + 1]]);
  return result;
}

// Write an Int32Array into WASM heap; returns the WASM pointer.
function mallocI32(mod: CoreModule, data: Int32Array): number {
  const ptr = mod._malloc(data.byteLength);
  mod.HEAP32.set(data, ptr >> 2);
  return ptr;
}

// Read n int32 quads from the shared i32 output buffer.
function readI32Out(mod: CoreModule, count: number): Int32Array {
  const base = mod._get_i32_out_buf() >> 2;
  return mod.HEAP32.slice(base, base + count * 4);
}

export interface Rectangle { minX: number; minY: number; maxX: number; maxY: number; }

// Matches TypeScript: mergeToRectangles(cells: Set<string>): Rectangle[]
// Accepts the same Set<string> format — converts internally before calling WASM.
export async function mergeToRectangles(cells: Set<string>): Promise<Rectangle[]> {
  if (cells.size === 0) return [];
  const mod = await loadWasmModule();

  // Pack "x,y" strings into flat Int32Array
  const flat = new Int32Array(cells.size * 2);
  let i = 0;
  for (const key of cells) {
    const comma = key.indexOf(",");
    flat[i++] = parseInt(key.slice(0, comma), 10);
    flat[i++] = parseInt(key.slice(comma + 1), 10);
  }

  const ptr = mallocI32(mod, flat);
  const nRects = mod._merge_to_rectangles(ptr, cells.size);
  mod._free(ptr);

  const out = readI32Out(mod, nRects);
  const result: Rectangle[] = [];
  for (let j = 0; j < nRects; j++) {
    result.push({
      minX: out[j * 4],
      minY: out[j * 4 + 1],
      maxX: out[j * 4 + 2],
      maxY: out[j * 4 + 3],
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sync API — zero-overhead wrappers for use after loadWasmModule() has resolved.
// The worker calls loadWasmModule() once on init, then uses these in hot loops.
//
// We NEVER cache typed array views backed by WASM memory — Emscripten reassigns
// Module.HEAPF64/HEAP32 on every memory growth event, so always read them fresh.
// We DO cache the malloc'd pointer integers; those stay valid across growths.
// ---------------------------------------------------------------------------

function getModule(): CoreModule {
  if (!_module) throw new Error("WASM not loaded — call loadWasmModule() first");
  return _module;
}

// Reusable input buffers — pointers grown on demand, never shrunk.
// Size tracked in elements (not bytes) so we know when to realloc.
let _inputF64Ptr = 0;
let _inputF64Elems = 0;

let _inputI32Ptr = 0;
let _inputI32Elems = 0;

function ensureF64Input(mod: CoreModule, count: number): void {
  if (_inputF64Elems < count) {
    if (_inputF64Ptr) mod._free(_inputF64Ptr);
    _inputF64Ptr = mod._malloc(count * 8);
    _inputF64Elems = count;
  }
}

function ensureI32Input(mod: CoreModule, count: number): void {
  if (_inputI32Elems < count) {
    if (_inputI32Ptr) mod._free(_inputI32Ptr);
    _inputI32Ptr = mod._malloc(count * 4);
    _inputI32Elems = count;
  }
}

export function samplePolylineSync(
  points: Array<[number, number]>,
  stepMeters: number,
): Array<{ x: number; y: number }> {
  const mod = getModule();
  const n = points.length;
  ensureF64Input(mod, n * 2);
  const heap = mod.HEAPF64;
  const inBase = _inputF64Ptr >> 3;
  for (let i = 0; i < n; i++) {
    heap[inBase + i * 2]     = points[i][0]; // lat
    heap[inBase + i * 2 + 1] = points[i][1]; // lng
  }
  const count = mod._sample_polyline(_inputF64Ptr, n, stepMeters);
  const out = mod.HEAPF64; // re-read in case growth happened
  const outBase = mod._get_f64_out_buf() >> 3;
  const result: Array<{ x: number; y: number }> = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = { x: out[outBase + i * 2], y: out[outBase + i * 2 + 1] };
  }
  return result;
}

export function trimPolylineByDistanceSync(
  points: Array<[number, number]>,
  distMeters: number,
): Array<[number, number]> {
  const mod = getModule();
  const n = points.length;
  ensureF64Input(mod, n * 2);
  const heap = mod.HEAPF64;
  const inBase = _inputF64Ptr >> 3;
  for (let i = 0; i < n; i++) {
    heap[inBase + i * 2]     = points[i][0];
    heap[inBase + i * 2 + 1] = points[i][1];
  }
  const count = mod._trim_polyline_by_distance(_inputF64Ptr, n, distMeters);
  const out = mod.HEAPF64;
  const outBase = mod._get_f64_out_buf() >> 3;
  const result: Array<[number, number]> = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = [out[outBase + i * 2], out[outBase + i * 2 + 1]];
  }
  return result;
}

export function mergeToRectanglesSync(cells: Set<string>): Rectangle[] {
  if (cells.size === 0) return [];
  const mod = getModule();
  ensureI32Input(mod, cells.size * 2);
  const heap = mod.HEAP32;
  const inBase = _inputI32Ptr >> 2;
  let i = 0;
  for (const key of cells) {
    const comma = key.indexOf(",");
    heap[inBase + i++] = parseInt(key.slice(0, comma), 10);
    heap[inBase + i++] = parseInt(key.slice(comma + 1), 10);
  }
  const nRects = mod._merge_to_rectangles(_inputI32Ptr, cells.size);
  const out = mod.HEAP32;
  const outBase = mod._get_i32_out_buf() >> 2;
  const result: Rectangle[] = new Array(nRects);
  for (let j = 0; j < nRects; j++) {
    result[j] = {
      minX: out[outBase + j * 4],
      minY: out[outBase + j * 4 + 1],
      maxX: out[outBase + j * 4 + 2],
      maxY: out[outBase + j * 4 + 3],
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistent visited set — wraps WASM-owned unordered_set<int64_t>
// ---------------------------------------------------------------------------

// Add a cell. Returns true if newly inserted.
export function visitedSetInsert(cx: number, cy: number): boolean {
  return getModule()._visited_set_insert(cx, cy) === 1;
}

export function visitedSetHas(cx: number, cy: number): boolean {
  return getModule()._visited_set_has(cx, cy) === 1;
}

export function visitedSetClear(): void {
  getModule()._visited_set_clear();
}

export function visitedSetSize(): number {
  return getModule()._visited_set_size();
}

// Dump the visited set back to "x,y" strings for serialization / postMessage.
export function visitedSetToStrings(): string[] {
  const mod = getModule();
  const count = mod._visited_set_to_array();
  const buf = mod.HEAP32;
  const base = mod._get_visited_dump_buf() >> 2;
  const result: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = `${buf[base + i * 2]},${buf[base + i * 2 + 1]}`;
  }
  return result;
}

// Populate the visited set from stored "x,y" strings (called on worker init).
export function visitedSetFromStrings(keys: string[]): void {
  const mod = getModule();
  for (const key of keys) {
    const comma = key.indexOf(",");
    mod._visited_set_insert(
      parseInt(key.slice(0, comma), 10),
      parseInt(key.slice(comma + 1), 10),
    );
  }
}

// Merge the WASM-owned visited set directly — no JS array needed.
export function mergeVisitedToRectanglesSync(): Rectangle[] {
  const mod = getModule();
  const nRects = mod._merge_visited_to_rectangles();
  if (nRects === 0) return [];
  const out = mod.HEAP32;
  const outBase = mod._get_i32_out_buf() >> 2;
  const result: Rectangle[] = new Array(nRects);
  for (let j = 0; j < nRects; j++) {
    result[j] = {
      minX: out[outBase + j * 4],
      minY: out[outBase + j * 4 + 1],
      maxX: out[outBase + j * 4 + 2],
      maxY: out[outBase + j * 4 + 3],
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fuzzy visited count — see computeVisitedCountForCells in stats.ts
// ---------------------------------------------------------------------------

export function isWasmLoaded(): boolean {
  return _module !== null;
}

// Second persistent input buffer for the "target" side of fuzzy count.
let _inputI32bPtr = 0;
let _inputI32bElems = 0;

function ensureI32bInput(mod: CoreModule, count: number): void {
  if (_inputI32bElems < count) {
    if (_inputI32bPtr) mod._free(_inputI32bPtr);
    _inputI32bPtr = mod._malloc(count * 4);
    _inputI32bElems = count;
  }
}

// Exact port of TypeScript computeVisitedCountForCells but runs in WASM.
export function countVisitedFuzzySync(
  targetCells: Set<string>,
  visitedCells: Set<string>,
): number {
  if (targetCells.size === 0) return 0;
  const mod = getModule();
  // Guard: function may be absent if the WASM binary is stale (not rebuilt after C++ changes).
  if (typeof mod._count_visited_fuzzy !== "function") {
    console.warn("WASM: _count_visited_fuzzy missing — run 'bun run build:wasm' to rebuild");
    return -1; // signal caller to fall back to TS
  }
  ensureI32bInput(mod, targetCells.size * 2);
  ensureI32Input(mod, visitedCells.size * 2);

  // Write target cells into buffer b
  const heap = mod.HEAP32;
  let baseB = _inputI32bPtr >> 2;
  let i = 0;
  for (const key of targetCells) {
    const comma = key.indexOf(",");
    heap[baseB + i++] = parseInt(key.slice(0, comma), 10);
    heap[baseB + i++] = parseInt(key.slice(comma + 1), 10);
  }
  // Write visited cells into buffer (shared with mergeToRectangles input)
  let baseA = _inputI32Ptr >> 2;
  i = 0;
  for (const key of visitedCells) {
    const comma = key.indexOf(",");
    heap[baseA + i++] = parseInt(key.slice(0, comma), 10);
    heap[baseA + i++] = parseInt(key.slice(comma + 1), 10);
  }
  return mod._count_visited_fuzzy(
    _inputI32bPtr, targetCells.size,
    _inputI32Ptr,  visitedCells.size,
  );
}