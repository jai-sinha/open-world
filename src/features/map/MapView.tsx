import { useRef, useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import { MAP_CONFIG, useApp } from "@/app/AppContext";
import { hydrateMapState, type HydratedMapState } from "@/features/map/map-state";

export default function MapView() {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const { onMapReady } = useApp();
	const [hydratedState, setHydratedState] = useState<HydratedMapState | null>(null);
	const [isReadyToCreateMap, setIsReadyToCreateMap] = useState(false);

	useEffect(() => {
		let cancelled = false;

		(async () => {
			const state = await hydrateMapState();
			if (cancelled) return;

			setHydratedState(state);
			setIsReadyToCreateMap(true);
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!containerRef.current || mapRef.current || !isReadyToCreateMap) return;

		const map = new maplibregl.Map({
			container: containerRef.current,
			style: MAP_CONFIG.style,
			center: hydratedState?.initialView?.center ?? MAP_CONFIG.defaultCenter,
			zoom: hydratedState?.initialView?.zoom ?? MAP_CONFIG.defaultZoom,
		});

		mapRef.current = map;

		map.on("load", () => {
			map.addControl(new maplibregl.NavigationControl(), "top-right");
			map.addControl(new maplibregl.FullscreenControl(), "top-right");
			map.addControl(
				new maplibregl.GeolocateControl({
					positionOptions: { enableHighAccuracy: true },
					trackUserLocation: true,
				}),
				"top-right",
			);

			onMapReady(map, hydratedState);
		});

		return () => {
			map.remove();
			mapRef.current = null;
		};
	}, [hydratedState, isReadyToCreateMap, onMapReady]);

	return <div id="map" ref={containerRef} />;
}
