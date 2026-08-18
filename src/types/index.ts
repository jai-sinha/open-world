// Core type definitions for the exploration map

export interface StravaActivity {
	id: number;
	name: string;
	type: string;
	distance: number;
	start_date_local: string;
	start_latlng?: [number, number];
	end_latlng?: [number, number];
	map?: {
		summary_polyline?: string;
		polyline?: string;
	};
	private?: boolean;
	visibility?: "everyone" | "followers_only" | "only_me";
}

export interface RouteActivityProperties {
	id: number;
	name: string;
	type: string;
	distance: number;
	date: string;
	color: string;
}

export interface RouteActivityFeature {
	type: "Feature";
	properties: RouteActivityProperties;
	geometry: {
		type: "LineString";
		coordinates: [number, number][];
	};
}

export interface StravaTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	athlete?: {
		id: number;
		username?: string;
		firstname?: string;
		lastname?: string;
	};
}

export interface GridCell {
	x: number;
	y: number;
}

export interface Rectangle {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface ProcessingConfig {
	samplingStep: number; // meters
	privacyDistance: number; // meters to remove from start/end
	skipPrivate: boolean;
}

export interface ProcessingState {
	visitedCells: Set<number>; // packed integer cells
	processedActivityIds: Set<number>;
	totalActivities: number;
	processedActivities: number;
	lastUpdate: number;
}

export interface ProgressPayload {
	cellCount?: number;
	initialized?: boolean;
	storedActivities?: number;
	configUpdated?: true;
	needsReprocess?: boolean;
	config?: ProcessingConfig;
	message?: string;
	noActivities?: boolean;
	queued?: boolean;
}

export interface RectanglesPayload {
	rectangles: Rectangle[];
	cellsAdded: number;
	totalCells: number;
	visitedCells: number[];
	processedActivityIds: number[];
	reprocessing?: boolean;
}

export interface CompletePayload {
	rectangles?: Rectangle[];
	totalCells?: number;
	visitedCells?: number[];
	processedActivityIds?: number[];
	cleared?: boolean;
	reprocessed?: boolean;
}

export interface ErrorPayload {
	message: string;
	error?: unknown;
}

export type WorkerMessage =
	| { type: "init"; data: { visitedCells?: number[]; processedActivityIds?: number[]; config?: ProcessingConfig; activities?: StravaActivity[] } }
	| { type: "process"; data: { activities: StravaActivity[]; batchSize?: number } }
	| { type: "updateConfig"; data: Partial<ProcessingConfig> & { forceReprocess?: boolean } }
	| { type: "clear" };

export type WorkerResponse =
	| { type: "progress"; progress?: number; total?: number; data: ProgressPayload }
	| { type: "rectangles"; progress?: number; total?: number; data: RectanglesPayload }
	| { type: "complete"; progress?: number; total?: number; data?: CompletePayload }
	| { type: "error"; progress?: number; total?: number; data?: ErrorPayload };

export interface BatchProcessRequest {
	activities: StravaActivity[];
	config: ProcessingConfig;
	existingCells?: number[]; // packed integer cells (for resuming)
}

export interface RenderUpdate {
	rectangles: Rectangle[];
	cellsAdded: number;
	progress: number;
	total: number;
}

export interface MapBounds {
	west: number;
	south: number;
	east: number;
	north: number;
}

export interface PrivacySettings {
	enabled: boolean;
	removeDistance: number; // meters
	skipPrivateActivities: boolean;
}

export interface AppConfig {
	strava: {
		clientId: string;
		redirectUri: string;
	};
	map: {
		defaultCenter: [number, number];
		defaultZoom: number;
		style: string;
	};
	processing: ProcessingConfig;
	privacy: PrivacySettings;
}

export interface StoredState {
	version: number;
	visitedCells: number[];
	processedActivityIds: number[];
	config: ProcessingConfig;
	lastSync: number;
}

export interface CachedActivities {
	version: number;
	activities: StravaActivity[];
	lastSync: number;
}

// Web Mercator projection helpers
export interface Point {
	x: number;
	y: number;
}

export interface LatLng {
	lat: number;
	lng: number;
}

export interface City {
	id: string;
	osmId: string;
	name: string;
	displayName: string;
	outline: [number, number][][];
	roadCells: Set<number> | null;
	roadTiles: string;
	center?: { lat: number; lng: number };
}

export interface CityStats {
	cityId: string;
	displayName: string;
	totalCells: number;
	visitedCount: number;
	percentage: number;
	center?: { lat: number; lng: number };
	outline?: [number, number][][];
}

export type CityProcessorMessage =
	| { type: "DISCOVER_CITIES"; payload: { activities: StravaActivity[]; visitedCells: number[]; tilesBaseUrl: string } }
	| { type: "UPDATE_VISITED_CELLS"; payload: { visitedCells: number[]; cities?: City[]; tilesBaseUrl?: string } }
	| { type: "CALCULATE_VIEWPORT_STATS"; payload: { bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number } } };

export type CityProcessorResponse =
	| { type: "PROGRESS"; payload: { percentage: number } }
	| { type: "COMPLETE"; payload: { stats: CityStats[]; cities: City[] } }
	| { type: "STATS_UPDATE"; payload: { stats: CityStats[] } }
	| { type: "VIEWPORT_STATS"; payload: { percentage: number } }
	| { type: "ERROR"; payload: { message: string } };
