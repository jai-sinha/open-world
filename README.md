# Strava Exploration Map

A client-side MapLibre-based exploration map that visualizes all your Strava activities on a single interactive map, showing explored vs unexplored areas. Built for performance with progressive processing, Web Workers, and IndexedDB persistence.

## Features

- **Client-First Architecture**: All processing happens in your browser using Web Workers
- **Progressive Processing**: Activities are processed in batches with real-time progress updates
- **Fast & Lightweight**: Grid/bitset approach with rectangle merging for efficient rendering
- **Smart Caching**: IndexedDB persistence for instant re-runs
- **Beautiful Visualization**: MapLibre GL canvas layer for smooth, high-performance rendering
- **Responsive UX**: Prioritize viewport activities
- **Stat Tracking**: See your percentage of explored roads and paths in any area, and your most explored cities!
- **Interactivity**: Hover a route to see details, or click it to open a sidebar with even more information
- **Privacy Controls**: Remove start/finishes, skip private activities

## Grid/Bitset Algorithm

1. **Decode Polyline**: Convert Strava's encoded polyline to lat/lng points
2. **Sample Points**: Sample every ~25m along the route
3. **Project to Meters**: Convert lat/lng to Web Mercator (EPSG:3857)
4. **Mark Grid Cells**: Divide into 50mx50m grid cells, mark visited
5. **Merge Rectangles**: Combine contiguous cells into larger rectangles
6. **Render**: Draw rectangles on canvas overlay

This approach is **10-100x more efficient** than buffering/unioning individual polylines.

## Tech Stack

**Frontend:**
- MapLibre GL JS - Map rendering
- TypeScript - Type safety
- Web Workers - Background processing
- IndexedDB (via `idb`) - Persistent storage

**Backend (minimal):**
- Bun - Server runtime & bundler
- OAuth token exchange only

**No heavy dependencies:**
- ❌ No React, Vue, or frameworks
- ❌ No Python or server-side processing
- ✅ Vanilla TS + minimal dependencies (@turf/helpers for point-in-polygon, @mapbox/polyline for decoding)
- ✅ Pre-bundled city boundaries (no external geo APIs for top ~200 cities)
- ✅ Optional Nominatim fallback for cities outside the bundle
