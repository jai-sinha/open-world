#include "core.h"
#include <cmath>
#include <vector>
#include <algorithm>
#include <unordered_set>
#include <cstdint>

// ---------------------------------------------------------------------------
// Constants (matching projection.ts)
// ---------------------------------------------------------------------------
static constexpr double EARTH_RADIUS  = 6378137.0;       // WGS84 metres
static constexpr double ORIGIN_SHIFT  = M_PI * EARTH_RADIUS;
static constexpr double DEG_TO_RAD    = M_PI / 180.0;

// ---------------------------------------------------------------------------
// Output buffers
// All array-returning functions write into these. The JS side reads from
// Module.HEAPF64 / Module.HEAP32 using the pointer returned by the accessor.
// Sized for the largest expected single-activity polyline (64k entries).
// ---------------------------------------------------------------------------
static double   f64_out[65536];
static int32_t  i32_out[65536];

double*  get_f64_out_buf() { return f64_out; }
int32_t* get_i32_out_buf() { return i32_out; }

// ---------------------------------------------------------------------------
// Hello-world
// ---------------------------------------------------------------------------
int hello() { return 42; }

// ---------------------------------------------------------------------------
// lat_lng_to_meters  — Web Mercator (EPSG:3857)
// Matches TypeScript: latLngToMeters()
// ---------------------------------------------------------------------------
void lat_lng_to_meters(double lat, double lng, double* out_x, double* out_y) {
    *out_x = (lng * ORIGIN_SHIFT) / 180.0;
    double y = std::log(std::tan((90.0 + lat) * DEG_TO_RAD / 2.0)) / DEG_TO_RAD;
    *out_y = (y * ORIGIN_SHIFT) / 180.0;
}

// ---------------------------------------------------------------------------
// meters_to_lat_lng
// Matches TypeScript: metersToLatLng()
// ---------------------------------------------------------------------------
void meters_to_lat_lng(double x, double y, double* out_lat, double* out_lng) {
    *out_lng = (x / ORIGIN_SHIFT) * 180.0;
    double lat = (y / ORIGIN_SHIFT) * 180.0;
    *out_lat = (180.0 / M_PI) * (2.0 * std::atan(std::exp(lat * DEG_TO_RAD)) - M_PI / 2.0);
}

// ---------------------------------------------------------------------------
// haversine_distance  — returns metres
// Matches TypeScript: haversineDistance()
// ---------------------------------------------------------------------------
double haversine_distance(double lat1, double lng1, double lat2, double lng2) {
    const double dLat = (lat2 - lat1) * DEG_TO_RAD;
    const double dLng = (lng2 - lng1) * DEG_TO_RAD;
    const double sinLat = std::sin(dLat / 2.0);
    const double sinLng = std::sin(dLng / 2.0);
    const double a = sinLat * sinLat +
        std::cos(lat1 * DEG_TO_RAD) * std::cos(lat2 * DEG_TO_RAD) * sinLng * sinLng;
    return EARTH_RADIUS * 2.0 * std::atan2(std::sqrt(a), std::sqrt(1.0 - a));
}

// ---------------------------------------------------------------------------
// sample_polyline
// Matches TypeScript: samplePolyline()
// Input:  latlng[0..n_points*2-1] as [lat0,lng0, lat1,lng1, ...]
// Output: f64_out as [x0,y0, x1,y1, ...] in Web Mercator metres
// Returns: number of output points
// ---------------------------------------------------------------------------
int sample_polyline(const double* latlng, int n_points, double step_meters) {
    if (n_points == 0) return 0;

    int out_count = 0;
    double accumulated = 0.0;

    // Always include first point
    lat_lng_to_meters(latlng[0], latlng[1], &f64_out[0], &f64_out[1]);
    out_count = 1;

    for (int i = 1; i < n_points; ++i) {
        const double lat1 = latlng[(i-1)*2 + 0];
        const double lng1 = latlng[(i-1)*2 + 1];
        const double lat2 = latlng[i*2 + 0];
        const double lng2 = latlng[i*2 + 1];

        const double seg_dist = haversine_distance(lat1, lng1, lat2, lng2);
        if (seg_dist == 0.0) continue;

        const double remaining_step = step_meters - accumulated;

        if (seg_dist >= remaining_step) {
            double dist_in_seg = remaining_step;
            while (dist_in_seg <= seg_dist) {
                const double ratio = dist_in_seg / seg_dist;
                const double lat = lat1 + (lat2 - lat1) * ratio;
                const double lng = lng1 + (lng2 - lng1) * ratio;
                lat_lng_to_meters(lat, lng,
                    &f64_out[out_count * 2],
                    &f64_out[out_count * 2 + 1]);
                ++out_count;
                dist_in_seg += step_meters;
            }
            accumulated = seg_dist - (dist_in_seg - step_meters);
        } else {
            accumulated += seg_dist;
        }
    }

    // Always include last point
    const double last_lat = latlng[(n_points-1)*2 + 0];
    const double last_lng = latlng[(n_points-1)*2 + 1];
    lat_lng_to_meters(last_lat, last_lng,
        &f64_out[out_count * 2],
        &f64_out[out_count * 2 + 1]);
    ++out_count;

    return out_count;
}

// ---------------------------------------------------------------------------
// trim_polyline_by_distance
// Matches TypeScript: trimPolylineByDistance()
// Input:  latlng[0..n_points*2-1] as [lat0,lng0, lat1,lng1, ...]
// Output: f64_out as [lat0,lng0, ...] (trimmed, same format as input)
// Returns: number of output points (0 if polyline becomes too short)
// ---------------------------------------------------------------------------
int trim_polyline_by_distance(const double* latlng, int n_points, double dist_meters) {
    if (dist_meters <= 0.0 || n_points < 3) {
        // No trimming needed — copy input to output buffer
        for (int i = 0; i < n_points * 2; ++i) f64_out[i] = latlng[i];
        return n_points;
    }

    // ---- Trim start ----
    double accumulated = 0.0;
    int start_cut_index = -1;
    double start_lat = 0.0, start_lng = 0.0;
    bool found_start = false;

    for (int i = 1; i < n_points; ++i) {
        const double lat1 = latlng[(i-1)*2 + 0];
        const double lng1 = latlng[(i-1)*2 + 1];
        const double lat2 = latlng[i*2 + 0];
        const double lng2 = latlng[i*2 + 1];
        const double seg_dist = haversine_distance(lat1, lng1, lat2, lng2);

        if (accumulated + seg_dist >= dist_meters) {
            const double needed = dist_meters - accumulated;
            if (needed <= 0.0 || needed >= seg_dist) {
                start_lat = lat2; start_lng = lng2;
                start_cut_index = i + 1;
            } else {
                const double ratio = needed / seg_dist;
                start_lat = lat1 + (lat2 - lat1) * ratio;
                start_lng = lng1 + (lng2 - lng1) * ratio;
                start_cut_index = i;
            }
            found_start = true;
            break;
        }
        accumulated += seg_dist;
    }

    if (!found_start) return 0;

    // Build filtered polyline
    std::vector<double> filtered;
    filtered.reserve((n_points - start_cut_index + 1) * 2);
    filtered.push_back(start_lat);
    filtered.push_back(start_lng);
    for (int k = start_cut_index; k < n_points; ++k) {
        filtered.push_back(latlng[k*2 + 0]);
        filtered.push_back(latlng[k*2 + 1]);
    }

    const int filtered_n = static_cast<int>(filtered.size() / 2);
    if (filtered_n < 2) return 0;

    // ---- Trim end ----
    double accumulated_end = 0.0;
    int end_cut_index = -1;
    double end_lat = 0.0, end_lng = 0.0;
    bool found_end = false;

    for (int i = filtered_n - 1; i > 0; --i) {
        const double lat1 = filtered[(i-1)*2 + 0];
        const double lng1 = filtered[(i-1)*2 + 1];
        const double lat2 = filtered[i*2 + 0];
        const double lng2 = filtered[i*2 + 1];
        const double seg_dist = haversine_distance(lat1, lng1, lat2, lng2);

        if (accumulated_end + seg_dist >= dist_meters) {
            const double needed = dist_meters - accumulated_end;
            if (needed <= 0.0 || needed >= seg_dist) {
                end_lat = lat1; end_lng = lng1;
                end_cut_index = i - 1;
            } else {
                const double keep_dist = seg_dist - needed;
                const double ratio = keep_dist / seg_dist;
                end_lat = lat1 + (lat2 - lat1) * ratio;
                end_lng = lng1 + (lng2 - lng1) * ratio;
                end_cut_index = i - 1;
            }
            found_end = true;
            break;
        }
        accumulated_end += seg_dist;
    }

    if (!found_end) {
        if (filtered_n < 2) return 0;
        for (int i = 0; i < filtered_n * 2; ++i) f64_out[i] = filtered[i];
        return filtered_n;
    }

    // Assemble result
    int out_count = 0;
    for (int k = 0; k <= end_cut_index; ++k) {
        f64_out[out_count * 2 + 0] = filtered[k*2 + 0];
        f64_out[out_count * 2 + 1] = filtered[k*2 + 1];
        ++out_count;
    }
    f64_out[out_count * 2 + 0] = end_lat;
    f64_out[out_count * 2 + 1] = end_lng;
    ++out_count;

    return out_count >= 2 ? out_count : 0;
}

// ---------------------------------------------------------------------------
// Cell packing helpers (internal)
// Packs two int32_t values into one int64_t for use in unordered_set.
// Handles negative coordinates correctly via the int32_t cast.
// Matches TypeScript: cellKey(x, y) → string  (but O(1) integer hash vs string)
// ---------------------------------------------------------------------------
static inline int64_t pack_cell(int32_t x, int32_t y) {
    return (static_cast<int64_t>(x) << 32) | static_cast<uint32_t>(y);
}

static inline void unpack_cell(int64_t key, int32_t& x, int32_t& y) {
    x = static_cast<int32_t>(key >> 32);
    y = static_cast<int32_t>(key & 0xFFFFFFFF);
}

// ---------------------------------------------------------------------------
// point_to_cell
// Matches TypeScript: pointToCell(x, y, cellSize)
// ---------------------------------------------------------------------------
void point_to_cell(double x, double y, double cell_size, int32_t* out_cx, int32_t* out_cy) {
    *out_cx = static_cast<int32_t>(std::floor(x / cell_size));
    *out_cy = static_cast<int32_t>(std::floor(y / cell_size));
}

// ---------------------------------------------------------------------------
// merge_from_set  (internal)
// Core rectangle-merge algorithm, operates on any unordered_set<int64_t>.
// Writes [minX,minY,maxX,maxY,...] quads to i32_out.
// Returns: number of rectangles.
// ---------------------------------------------------------------------------
struct Rect { int32_t minX, minY, maxX, maxY; };

static int merge_from_set(const std::unordered_set<int64_t>& cell_set) {
    const int n = static_cast<int>(cell_set.size());
    if (n == 0) return 0;

    // Sort cells by y then x for row-scan
    std::vector<std::pair<int32_t,int32_t>> sorted;
    sorted.reserve(n);
    for (int64_t key : cell_set) {
        int32_t x, y;
        unpack_cell(key, x, y);
        sorted.push_back({x, y});
    }
    std::sort(sorted.begin(), sorted.end(), [](const auto& a, const auto& b) {
        return a.second != b.second ? a.second < b.second : a.first < b.first;
    });

    // Grow rectangles
    std::vector<Rect> rects;
    std::unordered_set<int64_t> processed;
    processed.reserve(n);

    for (const auto& [sx, sy] : sorted) {
        if (processed.count(pack_cell(sx, sy))) continue;

        int32_t width = 1;
        while (cell_set.count(pack_cell(sx + width, sy))) ++width;

        int32_t height = 1;
        bool can_grow = true;
        while (can_grow) {
            for (int32_t dx = 0; dx < width; ++dx) {
                if (!cell_set.count(pack_cell(sx + dx, sy + height))) {
                    can_grow = false; break;
                }
            }
            if (can_grow) ++height;
        }

        for (int32_t dy = 0; dy < height; ++dy)
            for (int32_t dx = 0; dx < width; ++dx)
                processed.insert(pack_cell(sx + dx, sy + dy));

        rects.push_back({sx, sy, sx + width - 1, sy + height - 1});
    }

    // Merge vertically adjacent rects with the same x-extent
    std::sort(rects.begin(), rects.end(), [](const Rect& a, const Rect& b) {
        return a.minX != b.minX ? a.minX < b.minX : a.minY < b.minY;
    });

    std::vector<Rect> merged;
    merged.reserve(rects.size());
    Rect cur = rects[0];
    for (std::size_t i = 1; i < rects.size(); ++i) {
        const Rect& nxt = rects[i];
        if (cur.minX == nxt.minX && cur.maxX == nxt.maxX && cur.maxY + 1 == nxt.minY) {
            cur.maxY = nxt.maxY;
        } else {
            merged.push_back(cur);
            cur = nxt;
        }
    }
    merged.push_back(cur);

    const int n_rects = static_cast<int>(merged.size());
    for (int i = 0; i < n_rects; ++i) {
        i32_out[i*4 + 0] = merged[i].minX;
        i32_out[i*4 + 1] = merged[i].minY;
        i32_out[i*4 + 2] = merged[i].maxX;
        i32_out[i*4 + 3] = merged[i].maxY;
    }
    return n_rects;
}

// ---------------------------------------------------------------------------
// merge_to_rectangles  (public — takes JS-supplied cell array)
// ---------------------------------------------------------------------------
int merge_to_rectangles(const int32_t* cells_xy, int n_cells) {
    if (n_cells == 0) return 0;
    std::unordered_set<int64_t> cell_set;
    cell_set.reserve(n_cells);
    for (int i = 0; i < n_cells; ++i)
        cell_set.insert(pack_cell(cells_xy[i*2], cells_xy[i*2 + 1]));
    return merge_from_set(cell_set);
}

// ---------------------------------------------------------------------------
// Persistent visited set
// ---------------------------------------------------------------------------
static std::unordered_set<int64_t> visited_set;
static std::vector<int32_t> visited_dump_buf;

int32_t* get_visited_dump_buf() { return visited_dump_buf.data(); }

int32_t visited_set_insert(int32_t cx, int32_t cy) {
    return static_cast<int32_t>(visited_set.insert(pack_cell(cx, cy)).second);
}

int32_t visited_set_has(int32_t cx, int32_t cy) {
    return visited_set.count(pack_cell(cx, cy)) ? 1 : 0;
}

void visited_set_clear() {
    visited_set.clear();
}

int32_t visited_set_size() {
    return static_cast<int32_t>(visited_set.size());
}

// Dump all cells to visited_dump_buf as flat [x0,y0, x1,y1, ...]
// Returns: number of cells
int32_t visited_set_to_array() {
    const int32_t n = static_cast<int32_t>(visited_set.size());
    visited_dump_buf.resize(n * 2);
    int i = 0;
    for (int64_t key : visited_set) {
        int32_t x, y;
        unpack_cell(key, x, y);
        visited_dump_buf[i++] = x;
        visited_dump_buf[i++] = y;
    }
    return n;
}

// Merge the persistent visited set directly — no JS array copy needed.
int32_t merge_visited_to_rectangles() {
    return merge_from_set(visited_set);
}

// ---------------------------------------------------------------------------
// count_visited_fuzzy
// Matches TypeScript: computeVisitedCountForCells(targetCells, visitedCells)
//
// For each target cell: exact match in visited → count it.
// Otherwise: check 8 neighbours in 3×3 grid (excluding centre) → count if any hit.
// ---------------------------------------------------------------------------

static int32_t fuzzy_count_impl(
    const int32_t* target_xy, int32_t n_target,
    const std::unordered_set<int64_t>& vis)
{
    int32_t count = 0;
    for (int32_t i = 0; i < n_target; ++i) {
        const int32_t tx = target_xy[i*2];
        const int32_t ty = target_xy[i*2 + 1];
        if (vis.count(pack_cell(tx, ty))) {
            ++count;
            continue;
        }
        bool found = false;
        for (int32_t dx = -1; dx <= 1 && !found; ++dx) {
            for (int32_t dy = -1; dy <= 1 && !found; ++dy) {
                if (dx == 0 && dy == 0) continue;
                if (vis.count(pack_cell(tx + dx, ty + dy))) found = true;
            }
        }
        if (found) ++count;
    }
    return count;
}

int32_t count_visited_fuzzy(
    const int32_t* target_xy, int32_t n_target,
    const int32_t* visited_xy, int32_t n_visited)
{
    std::unordered_set<int64_t> vis;
    vis.reserve(n_visited);
    for (int32_t i = 0; i < n_visited; ++i)
        vis.insert(pack_cell(visited_xy[i*2], visited_xy[i*2 + 1]));
    return fuzzy_count_impl(target_xy, n_target, vis);
}

int32_t count_visited_fuzzy_vs_set(const int32_t* target_xy, int32_t n_target) {
    return fuzzy_count_impl(target_xy, n_target, visited_set);
}

