#include <catch2/catch_test_macros.hpp>
#include "../core.h"
#include <vector>
#include <algorithm>

// Helper: build a flat int32 array from {x,y} pairs
static std::vector<int32_t> make_cells(std::initializer_list<std::pair<int32_t,int32_t>> pairs) {
    std::vector<int32_t> out;
    for (auto [x, y] : pairs) { out.push_back(x); out.push_back(y); }
    return out;
}

struct Rect { int32_t minX, minY, maxX, maxY; };

// Read n rectangles back from i32_out
static std::vector<Rect> read_rects(int n) {
    int32_t* buf = get_i32_out_buf();
    std::vector<Rect> out(n);
    for (int i = 0; i < n; ++i) {
        out[i] = {buf[i*4+0], buf[i*4+1], buf[i*4+2], buf[i*4+3]};
    }
    return out;
}

// Return total cell area covered by rectangles
static int rect_area(const std::vector<Rect>& rects) {
    int area = 0;
    for (auto& r : rects) area += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    return area;
}

// ---------------------------------------------------------------------------
// point_to_cell
// ---------------------------------------------------------------------------
TEST_CASE("point_to_cell — basic floor division", "[grid]") {
    int32_t cx, cy;
    point_to_cell(125.0, 275.0, 50.0, &cx, &cy);
    REQUIRE(cx == 2);
    REQUIRE(cy == 5);
}

TEST_CASE("point_to_cell — negative coordinates", "[grid]") {
    int32_t cx, cy;
    point_to_cell(-125.0, -275.0, 50.0, &cx, &cy);
    REQUIRE(cx == -3); // floor(-125/50) = floor(-2.5) = -3
    REQUIRE(cy == -6); // floor(-275/50) = floor(-5.5) = -6
}

TEST_CASE("point_to_cell — exactly on boundary", "[grid]") {
    int32_t cx, cy;
    point_to_cell(100.0, 200.0, 50.0, &cx, &cy);
    REQUIRE(cx == 2);
    REQUIRE(cy == 4);
}

// ---------------------------------------------------------------------------
// merge_to_rectangles — edge cases
// ---------------------------------------------------------------------------
TEST_CASE("merge_to_rectangles — empty input", "[grid]") {
    REQUIRE(merge_to_rectangles(nullptr, 0) == 0);
}

TEST_CASE("merge_to_rectangles — single cell", "[grid]") {
    auto cells = make_cells({{3, 7}});
    int n = merge_to_rectangles(cells.data(), 1);
    REQUIRE(n == 1);
    auto rects = read_rects(n);
    REQUIRE(rects[0].minX == 3); REQUIRE(rects[0].minY == 7);
    REQUIRE(rects[0].maxX == 3); REQUIRE(rects[0].maxY == 7);
}

TEST_CASE("merge_to_rectangles — horizontal row merges to one rect", "[grid]") {
    // 5 cells in a row: (0,0)..(4,0) → one 5×1 rectangle
    auto cells = make_cells({{0,0},{1,0},{2,0},{3,0},{4,0}});
    int n = merge_to_rectangles(cells.data(), 5);
    REQUIRE(n == 1);
    auto rects = read_rects(n);
    REQUIRE(rects[0].minX == 0); REQUIRE(rects[0].maxX == 4);
    REQUIRE(rects[0].minY == 0); REQUIRE(rects[0].maxY == 0);
}

TEST_CASE("merge_to_rectangles — solid 3×3 block is one rectangle", "[grid]") {
    std::vector<int32_t> cells;
    for (int y = 0; y < 3; ++y)
        for (int x = 0; x < 3; ++x) { cells.push_back(x); cells.push_back(y); }
    int n = merge_to_rectangles(cells.data(), 9);
    REQUIRE(n == 1);
    auto rects = read_rects(n);
    REQUIRE(rects[0].minX == 0); REQUIRE(rects[0].maxX == 2);
    REQUIRE(rects[0].minY == 0); REQUIRE(rects[0].maxY == 2);
}

TEST_CASE("merge_to_rectangles — two disjoint cells", "[grid]") {
    auto cells = make_cells({{0,0},{5,5}});
    int n = merge_to_rectangles(cells.data(), 2);
    REQUIRE(n == 2);
    REQUIRE(rect_area(read_rects(n)) == 2);
}

TEST_CASE("merge_to_rectangles — L-shape produces two rectangles", "[grid]") {
    // ##
    // #
    // #
    // Column 0: y=0,1,2 + row y=0: x=0,1
    auto cells = make_cells({{0,0},{1,0},{0,1},{0,2}});
    int n = merge_to_rectangles(cells.data(), 4);
    // TS algorithm: grows (0,0) right to width=2, down: row y=1 only has (0,1) not (1,1)
    // so height=1. Then (0,1) → width=1, can grow down to (0,2) → height=2.
    // After vertical merge: two rects become two (different x-extents, can't merge).
    REQUIRE(n == 2);
    REQUIRE(rect_area(read_rects(n)) == 4); // total coverage preserved
}

TEST_CASE("merge_to_rectangles — two stacked rows, same width → vertical merge", "[grid]") {
    // Row y=0: x=0..2, Row y=1: x=0..2
    // growRectangle at (0,0): width=3, height=2 → single 3×2 rect.
    // No separate vertical merge needed, but result must be 1 rect.
    std::vector<int32_t> cells;
    for (int y = 0; y < 2; ++y)
        for (int x = 0; x < 3; ++x) { cells.push_back(x); cells.push_back(y); }
    int n = merge_to_rectangles(cells.data(), 6);
    REQUIRE(n == 1);
    auto rects = read_rects(n);
    REQUIRE(rects[0].maxX == 2); REQUIRE(rects[0].maxY == 1);
}

TEST_CASE("merge_to_rectangles — vertical merge of two same-width rects", "[grid]") {
    // Two 3×1 rows with a gap: y=0 and y=2 (not adjacent) → 2 rects
    // Two 3×1 rows adjacent: y=0 and y=1 → but growRectangle already handles that.
    // Test mergeVerticalRectangles path: staggered columns produce separate rects
    // that the vertical-merge pass can combine.
    // Build a column (x=0, y=0..3) — growRectangle gives width=1, height=4.
    std::vector<int32_t> cells;
    for (int y = 0; y < 4; ++y) { cells.push_back(0); cells.push_back(y); }
    int n = merge_to_rectangles(cells.data(), 4);
    REQUIRE(n == 1);
    auto rects = read_rects(n);
    REQUIRE(rects[0].minY == 0); REQUIRE(rects[0].maxY == 3);
}

TEST_CASE("merge_to_rectangles — negative coordinates", "[grid]") {
    auto cells = make_cells({{-2,-2},{-1,-2},{-2,-1},{-1,-1}});
    int n = merge_to_rectangles(cells.data(), 4);
    REQUIRE(n == 1);
    auto rects = read_rects(n);
    REQUIRE(rects[0].minX == -2); REQUIRE(rects[0].maxX == -1);
    REQUIRE(rects[0].minY == -2); REQUIRE(rects[0].maxY == -1);
}

TEST_CASE("merge_to_rectangles — cell area is always preserved", "[grid]") {
    // Scattered random-ish cells: total input area must equal sum of rect areas
    auto cells = make_cells({{0,0},{2,0},{4,0},{0,2},{2,2},{4,2},{1,1},{3,1}});
    int n = merge_to_rectangles(cells.data(), 8);
    REQUIRE(rect_area(read_rects(n)) == 8);
}
