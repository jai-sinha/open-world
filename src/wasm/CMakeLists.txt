cmake_minimum_required(VERSION 3.15)
project(open_world_core CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(EMSCRIPTEN)
    # -----------------------------------------------------------------------
    # WASM target — built with emcmake cmake + emmake make
    # -----------------------------------------------------------------------
    add_executable(core core.cpp)
    set_target_properties(core PROPERTIES
        OUTPUT_NAME "core"
        SUFFIX ".js"
    )
    target_link_options(core PRIVATE
        -sEXPORTED_FUNCTIONS=['_hello','_lat_lng_to_meters','_meters_to_lat_lng','_haversine_distance','_get_f64_out_buf','_get_i32_out_buf','_sample_polyline','_trim_polyline_by_distance','_point_to_cell','_merge_to_rectangles','_visited_set_insert','_visited_set_has','_visited_set_clear','_visited_set_size','_visited_set_to_array','_get_visited_dump_buf','_merge_visited_to_rectangles','_count_visited_fuzzy','_count_visited_fuzzy_vs_set','_malloc','_free']
        -sEXPORTED_RUNTIME_METHODS=['cwrap','HEAPF64','HEAP32','HEAPU8']
        -sMODULARIZE=1
        -sEXPORT_NAME=OpenWorldCore
        -sEXPORT_ES6=1
        -sENVIRONMENT=worker
        -O2
    )
else()
    # -----------------------------------------------------------------------
    # Native test target — built with plain cmake + make for fast iteration
    # Run: cmake -S . -B build-native && make -C build-native && ./build-native/test_core
    # -----------------------------------------------------------------------
    include(FetchContent)
    FetchContent_Declare(
        Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG        v3.7.1
    )
    FetchContent_MakeAvailable(Catch2)

    add_executable(test_core tests/test_projection.cpp tests/test_grid.cpp tests/test_visited.cpp tests/test_stats.cpp core.cpp)
    target_include_directories(test_core PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(test_core PRIVATE Catch2::Catch2WithMain)
endif()
