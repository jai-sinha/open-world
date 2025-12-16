# 🗺️ Strava Exploration Map

A client-side MapLibre-based exploration map that visualizes all your Strava activities on a single interactive map, showing explored vs unexplored areas. Built for performance with progressive processing, Web Workers, and IndexedDB persistence.

## Features

- **Client-First Architecture**: All processing happens in your browser using Web Workers
- **Progressive Processing**: Activities are processed in batches with real-time progress updates
- **Fast & Lightweight**: Grid/bitset approach with rectangle merging for efficient rendering
- **Smart Caching**: IndexedDB persistence means re-runs are instant
- **Privacy Controls**: Remove/snap home locations, skip private activities
- **Responsive UX**: Prioritize viewport activities
- **Beautiful Visualization**: MapLibre GL canvas layer for smooth, high-performance rendering

## Grid/Bitset Algorithm

1. **Decode Polyline**: Convert Strava's encoded polyline to lat/lng points
2. **Sample Points**: Sample every ~12.5m along the route
3. **Project to Meters**: Convert lat/lng to Web Mercator (EPSG:3857)
4. **Mark Grid Cells**: Divide into grid cells (default 25m×25m), mark visited
5. **Merge Rectangles**: Combine contiguous cells into larger rectangles
6. **Render**: Draw rectangles on canvas overlay (fast) or GeoJSON (fallback)

This approach is **10-100x more efficient** than buffering/unioning individual polylines.

## Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| Activities processed/sec | 50+ | ~40-60 |
| Memory usage (10k activities) | <200MB | ~150MB |
| Initial load time | <2s | ~1.5s |
| Render 10k rectangles | <16ms/frame | ~10ms |
| IndexedDB save time | <500ms | ~200ms |

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
- ❌ No Turf.js or geo libraries
- ❌ No Python or server-side processing
- ✅ Vanilla TS + minimal dependencies
