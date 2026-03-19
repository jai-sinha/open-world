#pragma once
#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

// Hello-world: verifies WASM loaded correctly
int hello();

// --- Pure math ---
double haversine_distance(double lat1, double lng1, double lat2, double lng2);
void lat_lng_to_meters(double lat, double lng, double* out_x, double* out_y);
void meters_to_lat_lng(double x, double y, double* out_lat, double* out_lng);

// --- Shared output buffers ---
// Array-returning functions write results into these static buffers.
// After a call, JS reads from Module.HEAPF64 / Module.HEAP32 using the pointer
// returned by the accessor, up to (return_value * stride) elements.
double*  get_f64_out_buf();
int32_t* get_i32_out_buf();

// --- sample_polyline ---
// Input:  flat [lat0,lng0, lat1,lng1, ...] array of n_points coordinate pairs
// Output: flat [x0,y0, x1,y1, ...] Web Mercator metre pairs in get_f64_out_buf()
// Returns: number of output points (total doubles = result * 2)
int sample_polyline(const double* latlng, int n_points, double step_meters);

// --- trim_polyline_by_distance ---
// Input:  flat [lat0,lng0, ...] array of n_points
// Output: trimmed [lat0,lng0, ...] in get_f64_out_buf()
// Returns: number of output points (total doubles = result * 2)
int trim_polyline_by_distance(const double* latlng, int n_points, double dist_meters);

// --- point_to_cell ---
// Converts a Web Mercator metre coordinate to a grid cell (x, y).
// Matches TypeScript: pointToCell(x, y, cellSize)
void point_to_cell(double x, double y, double cell_size, int32_t* out_cx, int32_t* out_cy);

// --- count_visited_fuzzy ---
// Counts how many target cells are "visited" — either exact match or a
// neighbour in the 3×3 grid around each cell (matches TypeScript fuzzy logic).
// Both arrays are flat [x0,y0, x1,y1, ...] int32 pairs.
// Returns: count of visited target cells.
int32_t count_visited_fuzzy(
    const int32_t* target_xy, int32_t n_target,
    const int32_t* visited_xy, int32_t n_visited);

// Same but uses the persistent visited_set for the "visited" side — useful
// when called from the same worker that owns the visited set.
int32_t count_visited_fuzzy_vs_set(const int32_t* target_xy, int32_t n_target);
// Input:  flat [x0,y0, x1,y1, ...] int32 cell coordinate pairs (caller-allocated via _malloc)
// Output: flat [minX,minY,maxX,maxY, ...] int32 quads in get_i32_out_buf()
// Returns: number of output rectangles (total int32s = result * 4)
int merge_to_rectangles(const int32_t* cells_xy, int n_cells);

// --- Persistent visited set ---
// Lives in WASM heap across calls. The worker interacts with it via these
// functions rather than maintaining a JS-side Set<string>.

// Add a cell. Returns 1 if newly inserted, 0 if already present.
int32_t visited_set_insert(int32_t cx, int32_t cy);

// Returns 1 if the cell is present, 0 otherwise.
int32_t visited_set_has(int32_t cx, int32_t cy);

// Remove all cells.
void visited_set_clear();

// Number of cells currently in the set.
int32_t visited_set_size();

// Dump all cells to a dynamic buffer; call get_visited_dump_buf() for the pointer.
// Returns: number of cells (total int32s = result * 2)
int32_t visited_set_to_array();

// Pointer to the dump buffer written by visited_set_to_array().
int32_t* get_visited_dump_buf();

// Merge the persistent visited set directly to rectangles (no JS input needed).
// Output: i32_out as [minX,minY,maxX,maxY, ...]
// Returns: number of rectangles
int32_t merge_visited_to_rectangles();

#ifdef __cplusplus
}
#endif
