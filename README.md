# Strava Exploration Map

A client-side MapLibre-based exploration map that visualizes all your Strava activities on a single interactive map to show explored and unexplored areas. Built for performance with progressive processing, Web Workers, and IndexedDB persistence.

## Features

- **Stat Tracking**: See your percentage of explored roads and paths in any area, and your most explored cities!
**Unexplored Areas**: Identify roads and paths you haven't ridden, run or walked yet
- **Interactivity**: Hover a route to see quick info, or click it to open a sidebar with more details
- **Privacy Controls**: Remove start/finishes, skip private activities, and no data is sent to any server
- **Client-First Architecture**: All processing happens in your browser using Web Workers
- **Progressive Processing**: Activities are processed in batches with real-time progress updates
- **Fast & Lightweight**: Grid/bitset approach with rectangle merging for efficient rendering
- **Smart Caching**: IndexedDB persistence for instant re-runs
- **Beautiful Visualization**: MapLibre GL canvas layer for smooth, high-performance rendering
- **Responsive UX**: Prioritize viewport activities
