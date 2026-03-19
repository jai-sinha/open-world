#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include "../core.h"
#include <cmath>

using Catch::Matchers::WithinRel;
using Catch::Matchers::WithinAbs;

// ---------------------------------------------------------------------------
// haversine_distance
// ---------------------------------------------------------------------------
TEST_CASE("haversine_distance — known distances", "[projection]") {
    // London → Paris ≈ 343.9 km
    double d = haversine_distance(51.5074, -0.1278, 48.8566, 2.3522);
    REQUIRE_THAT(d, WithinRel(343941.0, 0.005)); // 0.5% tolerance

    // Same point → 0
    REQUIRE_THAT(haversine_distance(48.0, 11.0, 48.0, 11.0), WithinAbs(0.0, 1e-9));

    // Antipodal points = half Earth circumference = pi * R ≈ 20,037,508 m
    double antipodal = haversine_distance(0.0, 0.0, 0.0, 180.0);
    REQUIRE_THAT(antipodal, WithinRel(20037508.0, 0.001));
}

// ---------------------------------------------------------------------------
// lat_lng_to_meters / meters_to_lat_lng  (round-trip)
// ---------------------------------------------------------------------------
TEST_CASE("lat_lng_to_meters — origin", "[projection]") {
    double x, y;
    lat_lng_to_meters(0.0, 0.0, &x, &y);
    REQUIRE_THAT(x, WithinAbs(0.0, 1e-6));
    REQUIRE_THAT(y, WithinAbs(0.0, 1e-6));
}

TEST_CASE("lat_lng_to_meters — known value (Munich)", "[projection]") {
    // Munich: lat=48.1351, lng=11.5820
    // Expected Web Mercator x ≈ 1_289_475 m, y ≈ 6_130_488 m
    double x, y;
    lat_lng_to_meters(48.1351, 11.5820, &x, &y);
    REQUIRE_THAT(x, WithinRel(1289475.0, 0.001));
    REQUIRE_THAT(y, WithinRel(6130488.0, 0.001));
}

TEST_CASE("meters_to_lat_lng — round trip", "[projection]") {
    const double orig_lat = 48.1351, orig_lng = 11.5820;
    double x, y;
    lat_lng_to_meters(orig_lat, orig_lng, &x, &y);
    double lat, lng;
    meters_to_lat_lng(x, y, &lat, &lng);
    REQUIRE_THAT(lat, WithinAbs(orig_lat, 1e-8));
    REQUIRE_THAT(lng, WithinAbs(orig_lng, 1e-8));
}

// ---------------------------------------------------------------------------
// sample_polyline
// ---------------------------------------------------------------------------
TEST_CASE("sample_polyline — empty input", "[projection]") {
    REQUIRE(sample_polyline(nullptr, 0, 25.0) == 0);
}

TEST_CASE("sample_polyline — two identical points", "[projection]") {
    double pts[] = {48.0, 11.0, 48.0, 11.0};
    int n = sample_polyline(pts, 2, 25.0);
    // First + last (same point duplicated)
    REQUIRE(n >= 1);
}

TEST_CASE("sample_polyline — straight line, known length", "[projection]") {
    // Two points ~100 m apart along the equator
    // lng difference for ~100 m at equator: 100 / (pi*R/180) ≈ 0.000899°
    const double lat = 0.0;
    const double lng1 = 0.0, lng2 = 0.001; // ≈ 111.3 m
    double pts[] = {lat, lng1, lat, lng2};

    // Step 25 m → expect ~4 interior samples + first + last = 6
    int n = sample_polyline(pts, 2, 25.0);
    REQUIRE(n >= 2); // at minimum first + last

    // Output in f64_out: check that x values are strictly increasing
    double* out = get_f64_out_buf();
    for (int i = 1; i < n; ++i) {
        REQUIRE(out[i*2] > out[(i-1)*2]); // x increasing along equator
    }
}

TEST_CASE("sample_polyline — single segment, step larger than segment", "[projection]") {
    // 50 m segment, 1000 m step → only first + last
    const double lat1 = 48.0, lng1 = 11.0;
    const double lat2 = 48.0, lng2 = 11.0005; // ~39 m at lat 48
    double pts[] = {lat1, lng1, lat2, lng2};
    int n = sample_polyline(pts, 2, 1000.0);
    REQUIRE(n == 2); // just first and last
}

// ---------------------------------------------------------------------------
// trim_polyline_by_distance
// ---------------------------------------------------------------------------
TEST_CASE("trim_polyline_by_distance — zero distance returns original", "[projection]") {
    double pts[] = {48.0, 11.0, 48.001, 11.0, 48.002, 11.0};
    int n = trim_polyline_by_distance(pts, 3, 0.0);
    REQUIRE(n == 3);
}

TEST_CASE("trim_polyline_by_distance — fewer than 3 points returns original", "[projection]") {
    double pts[] = {48.0, 11.0, 48.001, 11.0};
    int n = trim_polyline_by_distance(pts, 2, 100.0);
    REQUIRE(n == 2);
}

TEST_CASE("trim_polyline_by_distance — distance larger than polyline returns 0", "[projection]") {
    // Short polyline ~111 m, trim 500 m → nothing remains
    double pts[] = {0.0, 0.0,  0.0, 0.0005,  0.0, 0.001};
    int n = trim_polyline_by_distance(pts, 3, 500.0);
    REQUIRE(n == 0);
}

TEST_CASE("trim_polyline_by_distance — trims both ends", "[projection]") {
    // Build a straight E-W line with 10 points, each ~100 m apart → total ~900 m
    // Trim 150 m from each end → result should cover only the middle
    const int N = 10;
    double pts[N * 2];
    for (int i = 0; i < N; ++i) {
        pts[i*2 + 0] = 0.0;
        pts[i*2 + 1] = i * 0.001; // ~111 m per step at equator
    }

    double* out = get_f64_out_buf();
    int n = trim_polyline_by_distance(pts, N, 150.0);

    REQUIRE(n >= 2);
    // Trimmed start should have larger lng than original start
    REQUIRE(out[1] > pts[1]);
    // Trimmed end should have smaller lng than original end
    REQUIRE(out[(n-1)*2 + 1] < pts[(N-1)*2 + 1]);
}
