import type { ProcessingConfig, StravaActivity } from "@/types";
import { loadState } from "@/lib/storage";

export interface MapViewState {
	center: [number, number];
	zoom: number;
}

export interface HydratedMapState {
	initialView: MapViewState | null;
	activities: StravaActivity[];
	config: ProcessingConfig | null;
	visitedCells: number[];
	processedActivityIds: number[];
}

export function getLatestActivityCenter(activities: StravaActivity[]): MapViewState | null {
	const latestWithLocation = [...activities]
		.sort((a, b) => new Date(b.start_date_local).getTime() - new Date(a.start_date_local).getTime())
		.find((activity) => {
			const coords = activity.start_latlng;
			if (!coords || coords.length < 2) return false;

			const [lat, lng] = coords;
			return (
				typeof lat === "number" &&
				typeof lng === "number" &&
				!Number.isNaN(lat) &&
				!Number.isNaN(lng) &&
				lat !== 0 &&
				lng !== 0
			);
		});

	if (!latestWithLocation?.start_latlng) return null;

	const [lat, lng] = latestWithLocation.start_latlng;
	return {
		center: [lng, lat],
		zoom: 12,
	};
}

export async function hydrateMapState(): Promise<HydratedMapState> {
	try {
		const state = await loadState();

		return {
			initialView: state ? getLatestActivityCenter(state.activities) : null,
			activities: state?.activities ?? [],
			config: state?.config ?? null,
			visitedCells: state ? Array.from(state.visitedCells) : [],
			processedActivityIds: state ? Array.from(state.processedActivityIds) : [],
		};
	} catch (error) {
		console.error("Failed to load initial map state:", error);

		return {
			initialView: null,
			activities: [],
			config: null,
			visitedCells: [],
			processedActivityIds: [],
		};
	}
}
