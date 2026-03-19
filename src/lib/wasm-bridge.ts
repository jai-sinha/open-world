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
  mod.HEAPF64.set(data, ptr / 8);
  return ptr;
}

// Read n float64 pairs from the shared output buffer into a new Float64Array.
function readF64Out(mod: CoreModule, count: number): Float64Array {
  const ptr = mod._get_f64_out_buf();
  return mod.HEAPF64.slice(ptr / 8, ptr / 8 + count * 2);
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
  mod.HEAP32.set(data, ptr / 4);
  return ptr;
}

// Read n int32 quads from the shared i32 output buffer.
function readI32Out(mod: CoreModule, count: number): Int32Array {
  const ptr = mod._get_i32_out_buf();
  return mod.HEAP32.slice(ptr / 4, ptr / 4 + count * 4);
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
// ---------------------------------------------------------------------------

function getModule(): CoreModule {
  if (!_module) throw new Error("WASM not loaded — call loadWasmModule() first");
  return _module;
}

// Reusable input buffer — grown on demand, never shrunk, avoids per-call malloc.
let _inputF64: Float64Array = new Float64Array(0);
let _inputF64Ptr = 0;

let _inputI32: Int32Array = new Int32Array(0);
let _inputI32Ptr = 0;

function ensureF64Input(mod: CoreModule, count: number): void {
  if (_inputF64.length < count) {
    if (_inputF64Ptr) mod._free(_inputF64Ptr);
    _inputF64Ptr = mod._malloc(count * 8);
    _inputF64 = new Float64Array(mod.HEAPF64.buffer, _inputF64Ptr, count);
  }
}

function ensureI32Input(mod: CoreModule, count: number): void {
  if (_inputI32.length < count) {
    if (_inputI32Ptr) mod._free(_inputI32Ptr);
    _inputI32Ptr = mod._malloc(count * 4);
    _inputI32 = new Int32Array(mod.HEAP32.buffer, _inputI32Ptr, count);
  }
}

export function samplePolylineSync(
  points: Array<[number, number]>,
  stepMeters: number,
): Array<{ x: number; y: number }> {
  const mod = getModule();
  const n = points.length;
  ensureF64Input(mod, n * 2);
  for (let i = 0; i < n; i++) {
    _inputF64[i * 2]     = points[i][0]; // lat
    _inputF64[i * 2 + 1] = points[i][1]; // lng
  }
  const count = mod._sample_polyline(_inputF64Ptr, n, stepMeters);
  const outPtr = mod._get_f64_out_buf();
  const out = mod.HEAPF64;
  const base = outPtr / 8;
  const result: Array<{ x: number; y: number }> = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = { x: out[base + i * 2], y: out[base + i * 2 + 1] };
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
  for (let i = 0; i < n; i++) {
    _inputF64[i * 2]     = points[i][0];
    _inputF64[i * 2 + 1] = points[i][1];
  }
  const count = mod._trim_polyline_by_distance(_inputF64Ptr, n, distMeters);
  const outPtr = mod._get_f64_out_buf();
  const out = mod.HEAPF64;
  const base = outPtr / 8;
  const result: Array<[number, number]> = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = [out[base + i * 2], out[base + i * 2 + 1]];
  }
  return result;
}

export function mergeToRectanglesSync(cells: Set<string>): Rectangle[] {
  if (cells.size === 0) return [];
  const mod = getModule();
  ensureI32Input(mod, cells.size * 2);
  let i = 0;
  for (const key of cells) {
    const comma = key.indexOf(",");
    _inputI32[i++] = parseInt(key.slice(0, comma), 10);
    _inputI32[i++] = parseInt(key.slice(comma + 1), 10);
  }
  const nRects = mod._merge_to_rectangles(_inputI32Ptr, cells.size);
  const outPtr = mod._get_i32_out_buf();
  const out = mod.HEAP32;
  const base = outPtr / 4;
  const result: Rectangle[] = new Array(nRects);
  for (let j = 0; j < nRects; j++) {
    result[j] = {
      minX: out[base + j * 4],
      minY: out[base + j * 4 + 1],
      maxX: out[base + j * 4 + 2],
      maxY: out[base + j * 4 + 3],
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
  const ptr = mod._get_visited_dump_buf();
  const buf = mod.HEAP32;
  const base = ptr / 4;
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
  const outPtr = mod._get_i32_out_buf();
  const out = mod.HEAP32;
  const base = outPtr / 4;
  const result: Rectangle[] = new Array(nRects);
  for (let j = 0; j < nRects; j++) {
    result[j] = {
      minX: out[base + j * 4],
      minY: out[base + j * 4 + 1],
      maxX: out[base + j * 4 + 2],
      maxY: out[base + j * 4 + 3],
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
let _inputI32b: Int32Array = new Int32Array(0);
let _inputI32bPtr = 0;

function ensureI32bInput(mod: CoreModule, count: number): void {
  if (_inputI32b.length < count) {
    if (_inputI32bPtr) mod._free(_inputI32bPtr);
    _inputI32bPtr = mod._malloc(count * 4);
    _inputI32b = new Int32Array(mod.HEAP32.buffer, _inputI32bPtr, count);
  }
}

// Pack a Set<"x,y"> into a persistent int32 buffer; return element count.
function packCellSet(set: Set<string>, buf: Int32Array): number {
  let i = 0;
  for (const key of set) {
    const comma = key.indexOf(",");
    buf[i++] = parseInt(key.slice(0, comma), 10);
    buf[i++] = parseInt(key.slice(comma + 1), 10);
  }
  return set.size;
}

// Exact port of TypeScript computeVisitedCountForCells but runs in WASM.
export function countVisitedFuzzySync(
  targetCells: Set<string>,
  visitedCells: Set<string>,
): number {
  if (targetCells.size === 0) return 0;
  const mod = getModule();
  ensureI32bInput(mod, targetCells.size * 2);
  ensureI32Input(mod, visitedCells.size * 2);
  packCellSet(targetCells, _inputI32b);
  packCellSet(visitedCells, _inputI32);
  return mod._count_visited_fuzzy(
    _inputI32bPtr, targetCells.size,
    _inputI32Ptr,  visitedCells.size,
  );
}