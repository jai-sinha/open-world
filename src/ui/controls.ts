// UI controls for exploration map
// Handles progress display, privacy settings, stats, and city discovery lifecycle.

import type { ProcessingConfig, PrivacySettings } from "../types";
import { LocationSearchComponent } from "./components/location-search";
import { ProgressComponent } from "./components/progress";
import { StatsComponent } from "./components/stats";
import { CityStatsComponent } from "./components/city-stats";
import { PrivacyComponent } from "./components/privacy";
import { RouteControlsComponent } from "./components/route-controls";

export interface ControlsOptions {
	onPrivacyChange?: (settings: PrivacySettings) => void;
	onConfigChange?: (config: Partial<ProcessingConfig>) => void;
	onRouteToggle?: (visible: boolean) => void;
	onUnitsToggle?: (imperial: boolean) => void;
	onRouteStyleChange?: (style: {
		lineWidth?: number;
		lineOpacity?: number;
		colorByType?: boolean;
	}) => void;
	onToDateChange?: (toDate: Date | null) => void;
	onFromDateChange?: (fromDate: Date | null) => void;
	onLocationSelect?: (center: [number, number]) => void;
	onCityJump?: (payload: { center: [number, number]; outline?: [number, number][][] }) => void;
}

export class Controls {
	private container: HTMLElement;
	private options: ControlsOptions;
	private isProcessing = false;

	// Components
	private locationSearch: LocationSearchComponent;
	private progress: ProgressComponent;
	private stats: StatsComponent;
	private cityStats: CityStatsComponent;
	private privacy: PrivacyComponent;
	private routeControls: RouteControlsComponent;

	// Bound event handlers (kept for cleanup on destroy)
	private onCityDiscoveryStart: (e: Event) => void;
	private onCityDiscoveryProgress: (e: Event) => void;
	private onCityDiscoveryComplete: (e: Event) => void;
	private onCityStatsUpdate: (e: Event) => void;
	private onCityJump: (e: Event) => void;

	constructor(element: HTMLElement, options: ControlsOptions) {
		this.container = element;
		this.options = options;

		this.locationSearch = new LocationSearchComponent({
			onLocationSelect: (center) => this.options.onLocationSelect?.(center),
			onMessage: (msg, type) => this.showMessage(msg, type),
		});

		this.progress = new ProgressComponent();
		this.stats = new StatsComponent();
		this.cityStats = new CityStatsComponent();

		this.privacy = new PrivacyComponent({
			onPrivacyChange: (settings) => this.options.onPrivacyChange?.(settings),
		});

		this.routeControls = new RouteControlsComponent({
			onRouteToggle: (visible) => this.options.onRouteToggle?.(visible),
			onUnitsToggle: (imperial) => {
				this.options.onUnitsToggle?.(imperial);
				this.stats.setUnits(imperial);
			},
			onRouteStyleChange: (style) => this.options.onRouteStyleChange?.(style),
			onToDateChange: (toDate) => this.options.onToDateChange?.(toDate),
			onFromDateChange: (fromDate) => this.options.onFromDateChange?.(fromDate),
			activities: [],
		});

		// Bind event handlers once so they can be removed on destroy
		this.onCityDiscoveryStart = () => {
			this.cityStats.reset();
		};
		this.onCityDiscoveryProgress = (e: Event) => {
			const { percentage } = (e as CustomEvent<{ percentage: number }>).detail;
			this.cityStats.setDiscoveryProgress(percentage);
		};
		this.onCityDiscoveryComplete = (e: Event) => {
			const { stats } = (e as CustomEvent<{ stats: any[] }>).detail;
			if (stats) this.cityStats.setStats(stats, true);
		};
		this.onCityStatsUpdate = (e: Event) => {
			const { stats } = (e as CustomEvent<{ stats: any[] }>).detail;
			if (stats) this.cityStats.setStats(stats, false);
		};
		this.onCityJump = (e: Event) => {
			const { lat, lng, outline } = (
				e as CustomEvent<{
					lat: number;
					lng: number;
					outline?: [number, number][][];
				}>
			).detail;
			this.options.onCityJump?.({
				center: [lng, lat],
				outline,
			});
		};

		this.render();
		this.registerCityDiscoveryListeners();
	}

	private render(): void {
		this.container.innerHTML = "";
		this.container.appendChild(this.locationSearch.element);
		this.container.appendChild(this.progress.element);
		this.container.appendChild(this.stats.element);
		this.container.appendChild(this.cityStats.element);
		this.container.appendChild(this.privacy.element);
		this.container.appendChild(this.routeControls.element);
	}

	private registerCityDiscoveryListeners(): void {
		window.addEventListener("city-discovery-start", this.onCityDiscoveryStart);
		window.addEventListener("city-discovery-progress", this.onCityDiscoveryProgress);
		window.addEventListener("city-discovery-complete", this.onCityDiscoveryComplete);
		window.addEventListener("city-stats-update", this.onCityStatsUpdate);
		window.addEventListener("city-jump", this.onCityJump);
	}

	// ---------------------------------------------------------------------------
	// Processing lifecycle
	// ---------------------------------------------------------------------------

	/** Call when a processing run starts. Shows the progress bar. */
	beginProcessing(): void {
		this.isProcessing = true;
		this.progress.show();
	}

	/** Call when a processing run ends. Hides the progress bar after a short delay. */
	endProcessing(): void {
		this.isProcessing = false;
		setTimeout(() => {
			if (!this.isProcessing) this.progress.hide();
		}, 1000);
	}

	/** Update the progress bar value and label. */
	reportProgress(current: number, total: number, message?: string): void {
		const percentage = total > 0 ? (current / total) * 100 : 0;
		const text = message ?? `${current} / ${total}`;
		this.progress.update(percentage, text);
	}

	// ---------------------------------------------------------------------------
	// Stats
	// ---------------------------------------------------------------------------

	updateStats(stats: {
		cells?: number;
		activities?: number;
		distance?: number;
		area?: number;
		viewportExplored?: number;
	}): void {
		this.stats.updateStats(stats);
	}

	setUnits(imperial: boolean): void {
		this.stats.setUnits(imperial);
	}

	updateRouteActivityTypes(types: string[]): void {
		this.routeControls.updateActivityTypes(types);
	}

	updateRouteActivities(activities: Array<{ start_date_local: string }>): void {
		this.routeControls.updateActivities(activities);
	}

	// ---------------------------------------------------------------------------
	// Messages
	// ---------------------------------------------------------------------------

	showMessage(message: string, type: "info" | "success" | "warning" | "error" = "info"): void {
		const messageEl = document.createElement("div");
		messageEl.className = `message message-${type}`;
		messageEl.textContent = message;

		this.container.insertBefore(messageEl, this.container.firstChild);

		setTimeout(() => {
			messageEl.classList.add("fade-out");
			setTimeout(() => messageEl.remove(), 300);
		}, 3000);
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	destroy(): void {
		window.removeEventListener("city-discovery-start", this.onCityDiscoveryStart);
		window.removeEventListener("city-discovery-progress", this.onCityDiscoveryProgress);
		window.removeEventListener("city-discovery-complete", this.onCityDiscoveryComplete);
		window.removeEventListener("city-stats-update", this.onCityStatsUpdate);
		window.removeEventListener("city-jump", this.onCityJump);
		this.container.innerHTML = "";
	}
}

export function createControls(
	container: HTMLElement | string,
	options: ControlsOptions = {},
): Controls {
	const element = typeof container === "string" ? document.getElementById(container) : container;
	if (!element) throw new Error("Container element not found");
	return new Controls(element, options);
}
