// UI controls for exploration map
// Handles progress display, pause/resume, privacy settings, and configuration

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
	onLocationSelect?: (center: [number, number]) => void;
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

	// Event handlers for city discovery events (bound so they can be removed on destroy)
	private cityDiscoveryStartHandler?: (e: Event) => void;
	private cityDiscoveryProgressHandler?: (e: Event) => void;
	private cityDiscoveryCompleteHandler?: (e: Event) => void;

	constructor(element: HTMLElement, options: ControlsOptions) {
		this.container = element;
		this.options = options;

		// Initialize components
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
		});

		this.render();
		this.setupCityDiscoveryListeners();
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

	private setupCityDiscoveryListeners() {
		if (typeof window !== "undefined") {
			this.cityDiscoveryStartHandler = (e: Event) => {
				const evt = e as CustomEvent<{ total: number }>;
				this.cityStats.showProgress(0, evt.detail.total);
			};
			this.cityDiscoveryProgressHandler = (e: Event) => {
				const evt = e as CustomEvent<{ processed: number; total: number }>;
				this.cityStats.showProgress(evt.detail.processed, evt.detail.total);
			};
			this.cityDiscoveryCompleteHandler = (e: Event) => {
				const evt = e as CustomEvent<{ stats: any[] }>;
				if (evt.detail?.stats) this.cityStats.updateStats(evt.detail.stats);
			};

			window.addEventListener("city-discovery-start", this.cityDiscoveryStartHandler);
			window.addEventListener("city-discovery-progress", this.cityDiscoveryProgressHandler);
			window.addEventListener("city-discovery-complete", this.cityDiscoveryCompleteHandler);
		}
	}

	/**
	 * Show progress bar
	 */
	showProgress(visible: boolean = true): void {
		if (visible) {
			this.progress.show();
		} else {
			this.progress.hide();
		}
	}

	/**
	 * Update progress bar
	 */
	updateProgress(current: number, total: number, message?: string): void {
		const percentage = total > 0 ? (current / total) * 100 : 0;
		const text = message || `${current} / ${total}`;
		this.progress.update(percentage, text);
	}

	/**
	 * Show city processing progress
	 */
	showCityProcessing(current: number, total: number): void {
		this.cityStats.showProgress(current, total);
	}

	/**
	 * Update stats display
	 */
	updateStats(stats: {
		cells?: number;
		activities?: number;
		rectangles?: number;
		area?: number;
		viewportExplored?: number;
	}): void {
		this.stats.updateStats(stats);
	}

	/**
	 * Update city stats list
	 */
	updateCityStats(stats: any[]): void {
		this.cityStats.updateStats(stats);
	}

	/**
	 * Set processing state
	 */
	setProcessing(processing: boolean): void {
		this.isProcessing = processing;
		if (processing) {
			this.progress.show();
		} else {
			// Delay hiding slightly to show 100%
			setTimeout(() => {
				if (!this.isProcessing) {
					this.progress.hide();
				}
			}, 1000);
		}
	}

	/**
	 * Toggle units and update displayed units
	 */
	setUnits(imperial: boolean): void {
		this.stats.setUnits(imperial);
	}

	/**
	 * Update the route activity types shown in the legend.
	 */
	updateRouteActivityTypes(types: string[]): void {
		this.routeControls.updateActivityTypes(types);
	}

	/**
	 * Show message to user
	 */
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

	/**
	 * Destroy controls
	 */
	destroy(): void {
		// Remove any attached city discovery event listeners
		if (typeof window !== "undefined") {
			if (this.cityDiscoveryStartHandler)
				window.removeEventListener("city-discovery-start", this.cityDiscoveryStartHandler);
			if (this.cityDiscoveryProgressHandler)
				window.removeEventListener("city-discovery-progress", this.cityDiscoveryProgressHandler);
			if (this.cityDiscoveryCompleteHandler)
				window.removeEventListener("city-discovery-complete", this.cityDiscoveryCompleteHandler);
		}

		this.container.innerHTML = "";
	}
}

export function createControls(
	container: HTMLElement | string,
	options: ControlsOptions = {},
): Controls {
	const element = typeof container === "string" ? document.getElementById(container) : container;

	if (!element) {
		throw new Error("Container element not found");
	}

	return new Controls(element, options);
}
