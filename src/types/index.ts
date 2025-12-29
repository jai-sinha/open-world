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
	cellSize: number; // meters
	samplingStep: number; // meters
	privacyDistance: number; // meters to remove from start/end
	snapToGrid: boolean;
	skipPrivate: boolean;
}

export interface ProcessingState {
	visitedCells: Set<string>; // "x,y" keys
	processedActivityIds: Set<number>;
	totalActivities: number;
	processedActivities: number;
	lastUpdate: number;
}

export interface WorkerMessage {
	type: "init" | "process" | "clear" | "updateConfig";
	data?: any;
}

export interface WorkerResponse {
	type: "progress" | "complete" | "error" | "rectangles" | "cells";
	data?: any;
	progress?: number;
	total?: number;
}

export interface BatchProcessRequest {
	activities: StravaActivity[];
	config: ProcessingConfig;
	existingCells?: string[]; // for resuming
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
	snapToGrid: boolean;
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
	visitedCells: string[];
	processedActivityIds: number[];
	config: ProcessingConfig;
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

export interface RegionMap {
	[region: string]: string;
}

export interface CountryMap {
	default?: string;
	regions?: RegionMap;
}
