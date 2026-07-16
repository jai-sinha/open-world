# Open World

This web app overlays all of an athlete's Strava activities on an interactive map, as a way to see where they have and have not been. It also computes your "exploration percentage" within the bounds of every city you've recorded a Strava activity in, and within your viewport at all times.

## More Features
- Hover a route to see quick info, or click it to open a sidebar with more details
- Remove start/finishes, skip private activities, and no data is ever sent or stored on server
- All processing happens in your browser using Web Workers, saving me infra $
- IndexedDB persistence for faster re-runs and less R2 data fetches
- Jump from city to city worldwide with a search bar
