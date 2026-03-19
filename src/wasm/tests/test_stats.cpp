#include <catch2/catch_test_macros.hpp>
#include "../core.h"
#include <vector>

static std::vector<int32_t> xy(std::initializer_list<std::pair<int32_t,int32_t>> pairs) {
    std::vector<int32_t> v;
    for (auto [x, y] : pairs) { v.push_back(x); v.push_back(y); }
    return v;
}

// ---------------------------------------------------------------------------
// count_visited_fuzzy — two-array version
// ---------------------------------------------------------------------------
TEST_CASE("count_visited_fuzzy — exact match", "[stats]") {
    // (0,0) is neighbour of (1,1); (1,1) is exact; (2,2) is neighbour of (1,1)
    auto target  = xy({{0,0},{1,1},{2,2}});
    auto visited = xy({{1,1}});
    REQUIRE(count_visited_fuzzy(target.data(), 3, visited.data(), 1) == 3);
}

TEST_CASE("count_visited_fuzzy — neighbour match counts", "[stats]") {
    // target (0,0), visited (1,0) — one cell to the right
    auto target  = xy({{0,0}});
    auto visited = xy({{1,0}});
    REQUIRE(count_visited_fuzzy(target.data(), 1, visited.data(), 1) == 1);
}

TEST_CASE("count_visited_fuzzy — diagonal neighbour counts", "[stats]") {
    auto target  = xy({{0,0}});
    auto visited = xy({{1,1}});
    REQUIRE(count_visited_fuzzy(target.data(), 1, visited.data(), 1) == 1);
}

TEST_CASE("count_visited_fuzzy — 2-cell gap does not count", "[stats]") {
    auto target  = xy({{0,0}});
    auto visited = xy({{2,0}});
    REQUIRE(count_visited_fuzzy(target.data(), 1, visited.data(), 1) == 0);
}

TEST_CASE("count_visited_fuzzy — centre excluded (dx=0 dy=0)", "[stats]") {
    // Target (0,0) is NOT in visited. Only centre would be (0,0) — excluded.
    // No neighbours in visited either → 0.
    auto target  = xy({{0,0}});
    auto visited = xy({{5,5}});
    REQUIRE(count_visited_fuzzy(target.data(), 1, visited.data(), 1) == 0);
}

TEST_CASE("count_visited_fuzzy — all 8 neighbours trigger match", "[stats]") {
    auto target = xy({{0,0}});
    std::vector<std::pair<int32_t,int32_t>> nbrs = {
        {-1,-1},{0,-1},{1,-1},{-1,0},{1,0},{-1,1},{0,1},{1,1}
    };
    for (auto [nx, ny] : nbrs) {
        auto visited = xy({{nx, ny}});
        INFO("neighbour (" << nx << "," << ny << ")");
        REQUIRE(count_visited_fuzzy(target.data(), 1, visited.data(), 1) == 1);
    }
}

TEST_CASE("count_visited_fuzzy — empty target returns 0", "[stats]") {
    auto visited = xy({{0,0}});
    REQUIRE(count_visited_fuzzy(nullptr, 0, visited.data(), 1) == 0);
}

TEST_CASE("count_visited_fuzzy — empty visited returns 0", "[stats]") {
    auto target = xy({{0,0}});
    REQUIRE(count_visited_fuzzy(target.data(), 1, nullptr, 0) == 0);
}

TEST_CASE("count_visited_fuzzy — multiple targets, partial match", "[stats]") {
    // 5 targets; only 2 are near a visited cell
    auto target = xy({{0,0},{10,10},{20,20},{1,0},{9,10}});
    auto visited = xy({{0,0},{10,10}}); // exact matches for first two
    REQUIRE(count_visited_fuzzy(target.data(), 5, visited.data(), 2) == 4);
    // (0,0) exact, (10,10) exact, (1,0) neighbour of (0,0), (9,10) neighbour of (10,10)
    // (20,20) has no match
}

TEST_CASE("count_visited_fuzzy — negative coordinates", "[stats]") {
    auto target  = xy({{-5,-5}});
    auto visited = xy({{-4,-5}});
    REQUIRE(count_visited_fuzzy(target.data(), 1, visited.data(), 1) == 1);
}

// ---------------------------------------------------------------------------
// count_visited_fuzzy_vs_set — uses persistent visited_set
// ---------------------------------------------------------------------------
TEST_CASE("count_visited_fuzzy_vs_set — uses WASM visited set", "[stats]") {
    visited_set_clear();
    visited_set_insert(3, 3);
    visited_set_insert(10, 10);

    auto target = xy({{3,3},{4,3},{20,20}});
    // (3,3) exact, (4,3) neighbour of (3,3), (20,20) no match
    REQUIRE(count_visited_fuzzy_vs_set(target.data(), 3) == 2);
    visited_set_clear();
}

TEST_CASE("count_visited_fuzzy_vs_set — empty set returns 0", "[stats]") {
    visited_set_clear();
    auto target = xy({{0,0},{1,1}});
    REQUIRE(count_visited_fuzzy_vs_set(target.data(), 2) == 0);
}
