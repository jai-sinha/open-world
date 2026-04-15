import { useRef, useEffect } from "react";
import maplibregl from "maplibre-gl";
import { useApp } from "@/app/AppContext";

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const { onMapReady } = useApp();

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
      center: [11.582, 48.1351],
      zoom: 12,
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
        "top-right"
      );

      onMapReady(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onMapReady]);

  return <div id="map" ref={containerRef} />;
}
