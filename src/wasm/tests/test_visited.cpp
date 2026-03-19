#include <catch2/catch_test_macros.hpp>
#include "../core.h"
#include <vector>
#include <set>

// Helper: read n cells from visited_dump_buf as sorted {x,y} pairs
static std::set<std::pair<int32_t,int32_t>> dump_as_set() {
    int32_t n = visited_set_to_array();
    int32_t* buf = get_visited_dump_buf();
    std::set<std::pair<int32_t,int32_t>> out;
    for (int32_t i = 0; i < n; ++i) out.insert({buf[i*2], buf[i*2+1]});
    return out;
}

// Ensure clean slate before every test
static void reset() { visited_set_clear(); }

// ---------------------------------------------------------------------------
TEST_CASE("visited_set — insert and has", "[visited]") {
    reset();
    REQUIRE(visited_set_has(3, 7) == 0);
    REQUIRE(visited_set_insert(3, 7) == 1);  // newly inserted
    REQUIRE(visited_set_has(3, 7) == 1);
    REQUIRE(visited_set_insert(3, 7) == 0);  // duplicate → 0
}

TEST_CASE("visited_set — size", "[visited]") {
    reset();
    REQUIRE(visited_set_size() == 0);
    visited_set_insert(0, 0);
    visited_set_insert(1, 0);
    visited_set_insert(0, 0); // duplicate
    REQUIRE(visited_set_size() == 2);
}

TEST_CASE("visited_set — clear", "[visited]") {
    reset();
    visited_set_insert(1, 2);
    visited_set_insert(3, 4);
    visited_set_clear();
    REQUIRE(visited_set_size() == 0);
    REQUIRE(visited_set_has(1, 2) == 0);
}

TEST_CASE("visited_set — negative coordinates", "[visited]") {
    reset();
    visited_set_insert(-5, -10);
    REQUIRE(visited_set_has(-5, -10) == 1);
    REQUIRE(visited_set_has(5, 10) == 0);  // not the same as positive
}

TEST_CASE("visited_set_to_array — round-trips all cells", "[visited]") {
    reset();
    std::set<std::pair<int32_t,int32_t>> expected = {{0,0},{1,2},{-3,4},{100,-200}};
    for (auto [x, y] : expected) visited_set_insert(x, y);

    auto got = dump_as_set();
    REQUIRE(got == expected);
}

TEST_CASE("visited_set_to_array — empty set returns 0", "[visited]") {
    reset();
    REQUIRE(visited_set_to_array() == 0);
}

// ---------------------------------------------------------------------------
TEST_CASE("merge_visited_to_rectangles — single cell", "[visited]") {
    reset();
    visited_set_insert(2, 5);
    int n = merge_visited_to_rectangles();
    REQUIRE(n == 1);
    int32_t* out = get_i32_out_buf();
    REQUIRE(out[0] == 2); REQUIRE(out[1] == 5);
    REQUIRE(out[2] == 2); REQUIRE(out[3] == 5);
}

TEST_CASE("merge_visited_to_rectangles — 3x3 block is one rect", "[visited]") {
    reset();
    for (int y = 0; y < 3; ++y)
        for (int x = 0; x < 3; ++x)
            visited_set_insert(x, y);
    int n = merge_visited_to_rectangles();
    REQUIRE(n == 1);
    int32_t* out = get_i32_out_buf();
    REQUIRE(out[0] == 0); REQUIRE(out[2] == 2); // minX..maxX
    REQUIRE(out[1] == 0); REQUIRE(out[3] == 2); // minY..maxY
}

TEST_CASE("merge_visited_to_rectangles — area preserved", "[visited]") {
    reset();
    // Scattered cells; total rect area must equal cell count
    std::vector<std::pair<int32_t,int32_t>> cells = {
        {0,0},{2,0},{4,0},{0,2},{2,2},{4,2},{1,1},{3,1}
    };
    for (auto [x, y] : cells) visited_set_insert(x, y);
    int n = merge_visited_to_rectangles();
    int32_t* out = get_i32_out_buf();
    int area = 0;
    for (int i = 0; i < n; ++i)
        area += (out[i*4+2]-out[i*4+0]+1) * (out[i*4+3]-out[i*4+1]+1);
    REQUIRE(area == static_cast<int>(cells.size()));
}

TEST_CASE("merge_visited_to_rectangles — empty set returns 0", "[visited]") {
    reset();
    REQUIRE(merge_visited_to_rectangles() == 0);
}
