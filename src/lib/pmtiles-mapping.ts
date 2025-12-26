// Mapping of Country -> Region -> PMTiles filename
// Based on the provided list of available extracts.

interface RegionMap {
	[region: string]: string;
}

interface CountryMap {
	default?: string;
	regions?: RegionMap;
}

const MAPPING: Record<string, CountryMap> = {
	"United States": {
		regions: {
			"California": "california.pmtiles",
			"Colorado": "colorado.pmtiles",
			"Illinois": "illinois.pmtiles",
			"Indiana": "indiana.pmtiles",
			"Nevada": "nevada.pmtiles",
			"New York": "new-york.pmtiles",
			"Utah": "utah.pmtiles",
			"Wisconsin": "wisconsin.pmtiles",
		},
	},
	"Germany": {
		regions: {
			"Bayern": "bayern.pmtiles",
			"Bavaria": "bayern.pmtiles", // English alias
			"Baden-Württemberg": "baden-wuerttemberg.pmtiles",
		},
	},
	"Monaco": {
		default: "monaco.pmtiles",
	},
	"Switzerland": {
		default: "switzerland.pmtiles",
	},
	"India": {
		default: "india.pmtiles",
	},
	"France": {
		regions: {
			"Rhône-Alpes": "rhone-alpes.pmtiles",
			"Auvergne-Rhône-Alpes": "rhone-alpes.pmtiles", // Modern region
			"Provence-Alpes-Côte d'Azur": "provence-alpes-cote-d-azur.pmtiles",
		},
	},
};

/**
 * Resolves the PMTiles filename for a given country and region.
 * This is used to determine which road network tile archive to load
 * for a specific city.
 *
 * @param country - The country name (e.g. "United States", "Germany")
 * @param region - The region/state name (e.g. "California", "Bayern")
 * @returns The filename of the .pmtiles file, or null if not supported.
 */
export function getPMTilesFilename(country: string, region?: string): string | null {
	if (!country) return null;

	const countryEntry = MAPPING[country];
	if (!countryEntry) {
		return null;
	}

	// 1. Check for specific region mapping
	if (region && countryEntry.regions) {
		// Try exact match
		if (countryEntry.regions[region]) {
			return countryEntry.regions[region];
		}
	}

	// 2. Fallback to default country file if available
	if (countryEntry.default) {
		return countryEntry.default;
	}

	return null;
}

/**
 * Helper to check if we have coverage for a location before attempting to load tiles.
 */
export function hasRoadCoverage(country: string, region?: string): boolean {
	return getPMTilesFilename(country, region) !== null;
}
