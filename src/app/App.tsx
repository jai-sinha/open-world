import { useEffect } from "react";
import { AppProvider, useApp } from "./AppContext";

// Feature components — imported from their feature directories.
// These will be created separately; we import them here so the layout is complete.
// Until they exist the build will error, but the structure is correct.
import AuthSection from "@/features/auth/AuthSection";

import LocationSearch from "@/features/controls/LocationSearch";
import ProgressSection from "@/features/controls/ProgressBar";
import Stats from "@/features/stats/Stats";
import CityStatsPanel from "@/features/stats/CityStats";
import PrivacySettings from "@/features/controls/PrivacySettings";
import RouteControls from "@/features/controls/RouteControls";
import MapView from "@/features/map/MapView";
import ActivitySidebar from "@/features/sidebar/ActivitySidebar";

// ────────────────────────────────────────────────────────────
// AppShell — the inner component that consumes context
// ────────────────────────────────────────────────────────────

function AppShell() {
	const { initialize } = useApp();

	useEffect(() => {
		initialize();
	}, [initialize]);

	return (
		<>
			<div className="app-shell">
				{/* ── Left sidebar ── */}
				<div className="sidebar">
					<div className="sidebar-header">
						<h1>Open World</h1>
						<p className="subtitle">Strava Exploration Map</p>
					</div>

					<div className="sidebar-controls">
						<AuthSection />

						<LocationSearch />
						<ProgressSection />
						<Stats />
						<CityStatsPanel />
						<PrivacySettings />
						<RouteControls />
					</div>

					<div className="sidebar-footer">
						<a
							href="https://github.com/jai-sinha/open-world"
							target="_blank"
							rel="noopener noreferrer"
						>
							GitHub
						</a>
						<span aria-hidden="true">·</span>
						<a href="https://www.strava.com" target="_blank" rel="noopener noreferrer">
							Powered by Strava
						</a>
						<span aria-hidden="true">·</span>
						<a
							href="https://www.openstreetmap.org/copyright"
							target="_blank"
							rel="noopener noreferrer"
						>
							© OpenStreetMap
						</a>
					</div>
				</div>

				{/* ── Map area ── */}
				<MapView />
			</div>

			{/* ── Activity detail sidebar (overlay) ── */}
			<ActivitySidebar />
		</>
	);
}

// ────────────────────────────────────────────────────────────
// App — wraps everything in the provider
// ────────────────────────────────────────────────────────────

export default function App() {
	return (
		<AppProvider>
			<AppShell />
		</AppProvider>
	);
}
