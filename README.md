# Open World

While I do use Strava as a workout tracker and social platform, I also love looking at the maps of my routes, reminiscing on past vacations or today's Spaziergang through the activities I tracked. This web app expands on that, overlaying all of an athlete's Strava activities on a MapLibre map so they can see where in the world they have (and have not!) been. 

A main inspiration is open-world video games, where undiscovered areas appear "fogged" or greyed out until you go explore them. This will hopefully similarly act as an inspiration to check out new parts of familiar districts, like new neighborhoods in your city or trails off of your typical route. Of course, often times an area you **have** been to will appear unexplored, simply because this only sees what you've recorded on Strava, which I assume for most people is not every single step. In any case, close enough, unless you're interested in the privacy concerns (and extreme battery drain) that would come with 24/7 exact GPS tracking.

Another fun feature here is the total exploration percentage for a city, calculated as:

`(paths you've traversed within city bounds) / (all *traversable* paths in that city's bounds)`

This was a bit of a technical challenge to realize, as I had to find a way to **efficiently** store all these traversable routes and city boundaries, in order to avoid expensive 3rd party API fees and rate-limits. I ended up with a nice little ~25G Cloudflare R2 bucket comprised of `.pmtiles` road and reverse geocoding data split by continent and ~500k `.geojson` city boundary polylines. Thanks to $0.01/G storage, this will cost less than a buck a month, which is wayyy better than the aforementioned 3rd party options. Thank god for [planetiler](https://github.com/onthegomap/planetiler) and AI writing bash scripts to run it in maxed RAM Docker containers. This feature probably took the most time to get right out of anything in the project, and it wasn't even a part of my initial vision. Anyways, now that we own the data, I figured it'd be a shame not to also use it for viewport calculations: as long as you stay zoomed in at least enough that San Francisco fills your screen, you can see your exploration percentage for any given area, not just within specific city limits.

note: traversable meaning it appears as a path at the z14 level in OpenStreetMaps data, which encompasses most of the world's roads, trails, bike paths, etc. The idea here being that you're not penalized for not having a Strava activity cut through impassable areas, e.g. lakes, malls, or off-trail zones in a park. Though I could've certainly saved ~15G and my entire R2 fees if I'd taken a simpler approach here!

## More Features

- **Interactivity**: Hover a route to see quick info, or click it to open a sidebar with more details
- **Privacy Controls**: Remove start/finishes, skip private activities, and no data is ever sent or stored on server
- **Client-First Architecture**: All processing happens in your browser using Web Workers, saving me infra $
- **Progressive Processing**: Activities are processed in batches with real-time progress updates
- **Fast & Lightweight**: Grid/bitset approach with rectangle merging for efficient rendering
- **Smart Caching**: IndexedDB persistence for faster re-runs and less R2 data fetches
- **Beautiful Visualization**: MapLibre GL canvas layer for smooth, high-performance rendering
- **Quick Navigation**: Jump from location to location worldwide with a search bar
