// UI controls for exploration map
// Handles progress display, pause/resume, privacy settings, and configuration

import type { ProcessingConfig, PrivacySettings } from "../types";
import { ACTIVITY_COLORS } from "../lib/route-layer";

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

	private progressBar?: HTMLProgressElement;
	private progressText?: HTMLElement;
	private progressSection?: HTMLElement;
	private statsContainer?: HTMLElement;
	private routeLegendContainer?: HTMLElement;
	private routeLegendList?: HTMLElement;

	// Unit-related state and references for updating displayed units
	private imperialUnits = false;
	private privacyDistanceInput?: HTMLInputElement;
	private privacyDistanceValueEl?: HTMLElement;
	private privacyDistanceLabelEl?: HTMLLabelElement;
	private areaStatEl: HTMLElement | null = null;
	private lastAreaKm2 = 0;

	constructor(container: HTMLElement, options: ControlsOptions = {}) {
		this.container = container;
		this.options = options;
		this.render();
	}

	/**
	 * Render all control elements
	 */
	private render(): void {
		this.container.innerHTML = "";
		this.container.className = "exploration-controls";

		// Location Search
		const locationSection = this.createLocationSection();
		this.container.appendChild(locationSection);

		// Progress section
		const progressSection = this.createProgressSection();
		this.container.appendChild(progressSection);

		// Control buttons removed (pause/cancel removed; Clear Data functionality removed from UI)

		// Privacy settings
		const privacySection = this.createPrivacySection();
		this.container.appendChild(privacySection);

		// Route overlay settings
		const routeSection = this.createRouteSection();
		this.container.appendChild(routeSection);

		// Advanced settings
		const advancedSection = this.createAdvancedSection();
		this.container.appendChild(advancedSection);

		// Stats display
		const statsSection = this.createStatsSection();
		this.container.appendChild(statsSection);

		// Apply initial processing state (hide progress section if not processing)
		this.setProcessing(this.isProcessing);
	}

	/**
	 * Create location search section
	 */
	private createLocationSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section location-section";

		const title = document.createElement("h3");
		title.textContent = "Jump to Location";
		section.appendChild(title);

		const inputGroup = document.createElement("div");
		inputGroup.className = "input-group";
		inputGroup.style.display = "flex";
		inputGroup.style.gap = "8px";
		inputGroup.style.marginBottom = "10px";

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "City, Country, ZIP code...";
		input.style.flex = "1";
		input.style.padding = "4px";
		input.style.borderRadius = "4px";
		input.style.border = "1px solid #ccc";

		const button = document.createElement("button");
		button.textContent = "Go";
		button.style.padding = "4px 8px";
		button.style.cursor = "pointer";

		const handleSearch = async () => {
			const query = input.value.trim();
			if (!query) return;

			const originalText = button.textContent;
			button.disabled = true;
			button.textContent = "...";

			try {
				const response = await fetch(
					`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`,
				);
				const data = await response.json();

				if (data && data.length > 0) {
					const { lat, lon } = data[0];
					this.options.onLocationSelect?.([parseFloat(lon), parseFloat(lat)]);
				} else {
					this.showMessage("Location not found", "error");
				}
			} catch (e) {
				console.error("Search failed:", e);
				this.showMessage("Search failed", "error");
			} finally {
				button.disabled = false;
				button.textContent = originalText;
			}
		};

		button.onclick = handleSearch;
		input.onkeydown = (e) => {
			if (e.key === "Enter") handleSearch();
		};

		inputGroup.appendChild(input);
		inputGroup.appendChild(button);
		section.appendChild(inputGroup);

		return section;
	}

	/**
	 * Create progress display section
	 */
	private createProgressSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section progress-section";

		const title = document.createElement("h3");
		title.textContent = "Processing Progress";
		section.appendChild(title);

		// Progress bar
		this.progressBar = document.createElement("progress");
		this.progressBar.max = 100;
		this.progressBar.value = 0;
		section.appendChild(this.progressBar);

		// Progress text
		this.progressText = document.createElement("div");
		this.progressText.className = "progress-text";
		this.progressText.textContent = "Ready";
		section.appendChild(this.progressText);

		this.progressSection = section;
		if (!this.isProcessing) {
			this.progressSection.style.display = "none";
		}

		return section;
	}

	/**
	 * Show or hide the progress section without touching processing state or buttons
	 */
	showProgress(visible: boolean): void {
		if (!this.progressSection) return;

		this.progressSection.style.display = visible ? "" : "none";

		if (!visible) {
			if (this.progressBar) this.progressBar.value = 0;
			if (this.progressText) this.progressText.textContent = "Ready";
		}
	}

	/**
	 * Create route overlay section
	 */
	private createRouteSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section route-section";

		const header = document.createElement("div");
		header.className = "section-header";

		const title = document.createElement("h3");
		title.textContent = "Route Overlay";
		header.appendChild(title);

		section.appendChild(header);

		const content = document.createElement("div");
		content.className = "section-content";

		const togglesRow = document.createElement("div");
		togglesRow.style.display = "flex";
		togglesRow.style.gap = "1em";
		togglesRow.style.alignItems = "center";

		const visibilityToggle = this.createCheckbox(
			"route-visible",
			"Show Routes",
			true,
			(checked) => {
				this.options.onRouteToggle?.(checked);
				if (this.routeLegendContainer) {
					if (checked) {
						this.routeLegendContainer.style.display =
							this.routeLegendList && this.routeLegendList.childElementCount ? "" : "none";
					} else {
						this.routeLegendContainer.style.display = "none";
					}
				}
			},
		);
		togglesRow.appendChild(visibilityToggle);

		const unitsToggle = this.createCheckbox("route-imperial", "Imperial Units", false, (checked) =>
			this.options.onUnitsToggle?.(checked),
		);
		togglesRow.appendChild(unitsToggle);

		content.appendChild(togglesRow);

		const widthControl = this.createRangeControl(
			"route-width",
			"Line Width:",
			1,
			5,
			4.5,
			0.5,
			(value) => this.options.onRouteStyleChange?.({ lineWidth: value }),
		);
		content.appendChild(widthControl);

		const opacityControl = this.createRangeControl(
			"route-opacity",
			"Opacity:",
			0,
			1,
			0.5,
			0.1,
			(value) => this.options.onRouteStyleChange?.({ lineOpacity: value }),
		);
		content.appendChild(opacityControl);

		// Activity color legend (shows only activity types present)
		const legend = document.createElement("div");
		legend.className = "control-group route-legend";
		legend.style.display = "none";

		const legendTitle = document.createElement("label");
		legendTitle.textContent = "Activity Colors:";
		legend.appendChild(legendTitle);

		const legendList = document.createElement("div");
		legendList.className = "legend-items";
		legendList.style.display = "flex";
		legendList.style.flexWrap = "wrap";
		legendList.style.gap = "8px";
		legendList.style.marginTop = "6px";

		// keep references for dynamic updates (only show items for activity types that exist)
		this.routeLegendContainer = legend;
		this.routeLegendList = legendList;

		legend.appendChild(legendList);
		content.appendChild(legend);

		section.appendChild(content);
		return section;
	}

	/**
	 * Create privacy settings section
	 */
	private createPrivacySection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section privacy-section";

		const title = document.createElement("h3");
		title.textContent = "Privacy Settings";
		section.appendChild(title);

		// Privacy toggle
		const privacyToggle = this.createCheckbox(
			"privacy-enabled",
			"Enable Privacy Filter (remove first & last 400m)",
			false,
			(checked) => this.updatePrivacy({ enabled: checked }),
		);
		section.appendChild(privacyToggle);

		// Skip private activities
		const skipPrivate = this.createCheckbox(
			"skip-private",
			"Skip Private Activities",
			false,
			(checked) => this.updatePrivacy({ skipPrivateActivities: checked }),
		);
		section.appendChild(skipPrivate);

		return section;
	}

	/**
	 * Create advanced settings section
	 */
	private createAdvancedSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section advanced-section collapsed";

		const header = document.createElement("div");
		header.className = "section-header";
		header.onclick = () => section.classList.toggle("collapsed");

		const title = document.createElement("h3");
		title.textContent = "Advanced Settings";
		header.appendChild(title);

		const toggle = document.createElement("span");
		toggle.className = "toggle-icon";
		toggle.textContent = "▼";
		header.appendChild(toggle);

		section.appendChild(header);

		const content = document.createElement("div");
		content.className = "section-content";

		// Cell size selector
		const cellSizeControl = this.createRangeControl(
			"cell-size",
			"Grid Cell Size (m) (increase for better rendering performance):",
			10,
			100,
			50,
			5,
			(value) => this.updateConfig({ cellSize: value }),
		);
		content.appendChild(cellSizeControl);

		// Sampling step selector
		const samplingControl = this.createRangeControl(
			"sampling-step",
			"Sampling Step (m) (increase for better rendering performance):",
			5,
			50,
			25,
			2.5,
			(value) => this.updateConfig({ samplingStep: value }),
		);
		content.appendChild(samplingControl);

		section.appendChild(content);
		return section;
	}

	/**
	 * Create stats display section
	 */
	private createStatsSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section stats-section";

		const title = document.createElement("h3");
		title.textContent = "Statistics";
		section.appendChild(title);

		this.statsContainer = document.createElement("div");
		this.statsContainer.className = "stats-content";
		this.statsContainer.innerHTML = `
      <div class="stat-item">
        <span class="stat-label">Cells Visited:</span>
        <span class="stat-value" id="stat-cells">0</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Activities Processed:</span>
        <span class="stat-value" id="stat-activities">0</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Rectangles:</span>
        <span class="stat-value" id="stat-rectangles">0</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Area Explored:</span>
        <span class="stat-value" id="stat-area">0 km²</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Roads Explored:</span>
        <span class="stat-value" id="stat-viewport">0%</span>
      </div>
    `;
		section.appendChild(this.statsContainer);

		// Keep a reference to the area element so we can update unit formatting
		this.areaStatEl = this.statsContainer.querySelector("#stat-area") as HTMLElement | null;

		return section;
	}

	/**
	 * Create data management section
	 */
	/**
	 * Helper: Create checkbox control
	 */
	private createCheckbox(
		id: string,
		label: string,
		checked: boolean,
		onChange: (checked: boolean) => void,
	): HTMLElement {
		const control = document.createElement("div");
		control.className = "control-group checkbox-group";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.id = id;
		checkbox.checked = checked;
		checkbox.onchange = () => onChange(checkbox.checked);

		const labelEl = document.createElement("label");
		labelEl.htmlFor = id;
		labelEl.textContent = label;

		control.appendChild(checkbox);
		control.appendChild(labelEl);

		return control;
	}

	/**
	 * Helper: Create range control
	 */
	private createRangeControl(
		id: string,
		label: string,
		min: number,
		max: number,
		value: number,
		step: number,
		onChange: (value: number) => void,
	): HTMLElement {
		const control = document.createElement("div");
		control.className = "control-group range-group";

		const labelEl = document.createElement("label");
		labelEl.textContent = label;
		labelEl.htmlFor = id;
		control.appendChild(labelEl);

		const input = document.createElement("input");
		input.type = "range";
		input.id = id;
		input.min = min.toString();
		input.max = max.toString();
		input.step = step.toString();

		const valueDisplay = document.createElement("span");
		valueDisplay.className = "value-display";

		// ensure slider UI and numeric values stay aligned during inital render
		// i shoulda just used react lol
		const clampValue = (raw: number): number => {
			if (Number.isNaN(raw)) return min;
			return Math.min(max, Math.max(min, raw));
		};

		const setInputValue = (raw: number): number => {
			const clamped = clampValue(raw);
			input.value = clamped.toString();
			valueDisplay.textContent = clamped.toString();
			return clamped;
		};

		setInputValue(value);

		input.oninput = () => {
			const clamped = setInputValue(parseFloat(input.value));
			onChange(clamped);
		};

		control.appendChild(input);
		control.appendChild(valueDisplay);

		return control;
	}

	/**
	 * Update progress display
	 */
	updateProgress(current: number, total: number, message?: string): void {
		if (this.progressBar) {
			const percentage = total > 0 ? (current / total) * 100 : 0;
			this.progressBar.value = percentage;
		}

		if (this.progressText) {
			const text = message || `${current} / ${total} activities`;
			this.progressText.textContent = text;
		}
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
		if (!this.statsContainer) return;

		if (stats.cells !== undefined) {
			const el = this.statsContainer.querySelector("#stat-cells");
			if (el) el.textContent = stats.cells.toLocaleString();
		}

		if (stats.activities !== undefined) {
			const el = this.statsContainer.querySelector("#stat-activities");
			if (el) el.textContent = stats.activities.toLocaleString();
		}

		if (stats.rectangles !== undefined) {
			const el = this.statsContainer.querySelector("#stat-rectangles");
			if (el) el.textContent = stats.rectangles.toLocaleString();
		}

		if (stats.area !== undefined) {
			this.lastAreaKm2 = stats.area; // store for unit toggling
			if (this.areaStatEl) {
				if (this.imperialUnits) {
					// convert km² to mi²
					const areaMi = stats.area * 0.3861021585;
					this.areaStatEl.textContent = `${areaMi.toFixed(2)} mi²`;
				} else {
					this.areaStatEl.textContent = `${stats.area.toFixed(2)} km²`;
				}
			}
		}

		if (stats.viewportExplored !== undefined) {
			const el = this.statsContainer.querySelector("#stat-viewport");
			if (el) el.textContent = `${stats.viewportExplored.toFixed(2)}%`;
		}
	}

	/**
	 * Set processing state
	 */
	setProcessing(processing: boolean): void {
		this.isProcessing = processing;

		// Show/hide progress section based on processing state
		if (this.progressSection) {
			this.progressSection.style.display = processing ? "" : "none";
		}

		// Reset progress display when processing stops
		if (!processing) {
			if (this.progressBar) {
				this.progressBar.value = 0;
			}
			if (this.progressText) {
				this.progressText.textContent = "Ready";
			}
		}
	}

	// Pause/resume functionality removed

	// Cancel handler removed (UI no longer exposes cancel button)

	// Clear handled at top-level auth area now

	/**
	 * Handle import
	 */
	/**
	 * Update privacy settings
	 */
	private updatePrivacy(partial: Partial<PrivacySettings>): void {
		this.options.onPrivacyChange?.({
			enabled: false,
			removeDistance: 100,
			snapToGrid: false,
			skipPrivateActivities: false,
			...partial,
		});
	}

	/**
	 * Update processing config
	 */
	private updateConfig(partial: Partial<ProcessingConfig>): void {
		this.options.onConfigChange?.(partial);
	}

	/**
	 * Toggle units and update displayed units
	 */
	setUnits(imperial: boolean): void {
		this.imperialUnits = imperial;

		// Update units checkbox state if present
		const checkbox = document.getElementById("route-imperial") as HTMLInputElement | null;
		if (checkbox) checkbox.checked = imperial;

		// Update privacy label and value display
		if (this.privacyDistanceLabelEl) {
			this.privacyDistanceLabelEl.textContent = `Remove Distance (${imperial ? "ft" : "m"}):`;
		}
		if (this.privacyDistanceInput && this.privacyDistanceValueEl) {
			const meters = parseInt(this.privacyDistanceInput.value, 10) || 0;
			if (imperial) {
				const feet = Math.round(meters * 3.280839895);
				this.privacyDistanceValueEl.textContent = `${feet}ft`;
			} else {
				this.privacyDistanceValueEl.textContent = `${meters}m`;
			}
		}

		// Update area display based on last known area
		if (this.areaStatEl) {
			if (imperial) {
				const areaMi = this.lastAreaKm2 * 0.3861021585;
				this.areaStatEl.textContent = `${areaMi.toFixed(2)} mi²`;
			} else {
				this.areaStatEl.textContent = `${this.lastAreaKm2.toFixed(2)} km²`;
			}
		}
	}

	/**
	 * Update the route activity types shown in the legend.
	 * Pass an array of activity type strings (e.g. ['Run', 'Ride']).
	 * If the array is empty or no known types are present, the legend is hidden.
	 */
	updateRouteActivityTypes(types: string[]): void {
		if (!this.routeLegendList || !this.routeLegendContainer) return;

		const provided = new Set(types || []);

		// Keep known types in the defined order, only those present
		const knownOrder = Object.keys(ACTIVITY_COLORS).filter((k) => k !== "default");
		const presentKnown = knownOrder.filter((k) => provided.has(k));

		// Any unknown types should be shown with default color
		const unknowns = Array.from(provided).filter(
			(t) => !Object.prototype.hasOwnProperty.call(ACTIVITY_COLORS, t),
		);

		// Clear existing items
		this.routeLegendList.innerHTML = "";

		if (presentKnown.length === 0 && unknowns.length === 0) {
			// Nothing to show
			this.routeLegendContainer.style.display = "none";
			return;
		}

		// Show container only if the routes overlay is visible
		const routesVisible =
			(document.getElementById("route-visible") as HTMLInputElement | null)?.checked ?? true;
		this.routeLegendContainer.style.display = routesVisible ? "" : "none";

		const addItem = (type: string, color: string) => {
			const item = document.createElement("div");
			item.className = "legend-item";
			item.style.display = "inline-flex";
			item.style.alignItems = "center";
			item.style.marginRight = "12px";
			item.style.fontSize = "13px";

			const swatch = document.createElement("span");
			swatch.className = "legend-swatch";
			swatch.style.cssText = `display:inline-block; width:12px; height:12px; background:${color}; border-radius:2px; margin-right:6px; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06);`;

			const label = document.createElement("span");
			label.className = "legend-label";
			label.textContent = type === "default" ? "Other" : type;

			item.appendChild(swatch);
			item.appendChild(label);
			this.routeLegendList!.appendChild(item);
		};

		presentKnown.forEach((t) => addItem(t, ACTIVITY_COLORS[t] || ACTIVITY_COLORS.default));
		unknowns.forEach((t) => addItem(t, ACTIVITY_COLORS.default));
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
		this.container.innerHTML = "";
	}
}

/**
 * Create controls instance
 */
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
