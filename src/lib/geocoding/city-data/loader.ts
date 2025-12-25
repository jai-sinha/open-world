/**
 * City Boundary Data Loader
 *
 * Loads pre-bundled city boundaries from the static data file and provides
 * a fast lookup mechanism. Falls back to Nominatim for cities not in the bundle.
 */

export interface CityBoundary {
	id: string;
	name: string;
	country: string;
	geometry: GeoJSON.Geometry;
	bbox?: [number, number, number, number];
}

export interface CityBoundaryBundle {
	version: string;
	generated: string;
	cities: CityBoundary[];
}

class CityBoundaryLoader {
	private bundleData: Map<string, CityBoundary> = new Map();
	private isLoaded = false;
	private loadPromise: Promise<void> | null = null;

	/**
	 * Load the pre-bundled city boundaries from the static data file.
	 * Automatically decompresses gzipped data if needed.
	 */
	async load(): Promise<void> {
		// Avoid loading multiple times
		if (this.isLoaded) return;
		if (this.loadPromise) return this.loadPromise;

		this.loadPromise = this._load();
		await this.loadPromise;
	}

	private async _load(): Promise<void> {
		try {
			// Fetch the gzipped bundle
			const response = await fetch("/data/city-boundaries.json.gz", {
				headers: { Accept: "application/gzip, application/json" },
			});

			if (!response.ok) {
				console.warn(`Failed to load city boundaries: HTTP ${response.status}`);
				this.isLoaded = true;
				return;
			}

			// Decompress if the response is gzipped
			let bundle: CityBoundaryBundle;

			const contentEncoding = response.headers.get("content-encoding");
			if (contentEncoding?.includes("gzip")) {
				// Browser will auto-decompress with accept-encoding: gzip
				const json = await response.json();
				bundle = json as CityBoundaryBundle;
			} else {
				// Fallback: try to decompress manually if needed
				const buffer = await response.arrayBuffer();
				if (this.isGzipped(buffer)) {
					const decompressed = await this.decompressGzip(buffer);
					const text = new TextDecoder().decode(decompressed);
					bundle = JSON.parse(text) as CityBoundaryBundle;
				} else {
					const text = new TextDecoder().decode(buffer);
					bundle = JSON.parse(text) as CityBoundaryBundle;
				}
			}

			// Index cities by ID (name, country) for fast lookup
			for (const city of bundle.cities) {
				this.bundleData.set(city.id, city);
			}

			console.log(
				`Loaded ${bundle.cities.length} city boundaries from bundle (${bundle.generated})`,
			);
			this.isLoaded = true;
		} catch (error) {
			console.error("Error loading city boundaries bundle:", error);
			this.isLoaded = true;
		}
	}

	/**
	 * Get a city boundary by ID (city name, country).
	 * Returns null if not found in the bundle.
	 */
	getByID(cityID: string): CityBoundary | null {
		return this.bundleData.get(cityID) ?? null;
	}

	/**
	 * Check if a city boundary is available in the bundle.
	 */
	has(cityID: string): boolean {
		return this.bundleData.has(cityID);
	}

	/**
	 * Get all loaded cities.
	 */
	getAll(): CityBoundary[] {
		return Array.from(this.bundleData.values());
	}

	/**
	 * Get the count of loaded cities.
	 */
	getCount(): number {
		return this.bundleData.size;
	}

	/**
	 * Check if gzip magic number (1f 8b) is present.
	 */
	private isGzipped(buffer: ArrayBuffer): boolean {
		const view = new Uint8Array(buffer);
		return view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b;
	}

	/**
	 * Decompress gzip data in the browser.
	 * Uses the built-in DecompressionStream if available, otherwise falls back to a simple approach.
	 */
	private async decompressGzip(buffer: ArrayBuffer): Promise<Uint8Array> {
		// Check if DecompressionStream is available (modern browsers)
		if ("DecompressionStream" in window) {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(buffer));
					controller.close();
				},
			});

			const decompressedStream = stream.pipeThrough(
				new (window as any).DecompressionStream("gzip"),
			);
			const reader = decompressedStream.getReader();
			const chunks: Uint8Array[] = [];

			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					chunks.push(value as Uint8Array);
				}
			}

			const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const result = new Uint8Array(totalLength);
			let offset = 0;

			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.length;
			}

			return result;
		}

		// Fallback: Try to use pako if available (must be included in the app)
		if ((window as any).pako) {
			return (window as any).pako.inflate(new Uint8Array(buffer));
		}

		// If neither is available, log a warning and return empty
		console.warn(
			"DecompressionStream not available and pako not found. City boundaries may not decompress.",
		);
		return new Uint8Array();
	}
}

// Export a singleton instance
export const cityBoundaryLoader = new CityBoundaryLoader();
