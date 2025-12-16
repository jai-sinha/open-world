// UI controls for exploration map
// Handles progress display, pause/resume, privacy settings, and configuration

import type { ProcessingConfig, PrivacySettings } from "../types";

export interface ControlsOptions {
	onPause?: () => void;
	onResume?: () => void;
	onCancel?: () => void;
	onClear?: () => void;
	onPrivacyChange?: (settings: PrivacySettings) => void;
	onConfigChange?: (config: Partial<ProcessingConfig>) => void;
	onExport?: () => void;
	onImport?: (file: File) => void;
	onRouteToggle?: (visible: boolean) => void;
	onRouteStyleChange?: (style: {
		lineWidth?: number;
		lineOpacity?: number;
		colorByType?: boolean;
	}) => void;
}

export class Controls {
	private container: HTMLElement;
	private options: ControlsOptions;
	private isPaused = false;
	private isProcessing = false;

	private progressBar?: HTMLProgressElement;
	private progressText?: HTMLElement;
	private pauseButton?: HTMLButtonElement;
	private cancelButton?: HTMLButtonElement;
	private clearButton?: HTMLButtonElement;
	private statsContainer?: HTMLElement;

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

		// Progress section
		const progressSection = this.createProgressSection();
		this.container.appendChild(progressSection);

		// Control buttons
		const controlSection = this.createControlSection();
		this.container.appendChild(controlSection);

		// Privacy settings
		const privacySection = this.createPrivacySection();
		this.container.appendChild(privacySection);

		// Advanced settings
		const advancedSection = this.createAdvancedSection();
		this.container.appendChild(advancedSection);

		// Route overlay settings
		const routeSection = this.createRouteSection();
		this.container.appendChild(routeSection);

		// Stats display
		const statsSection = this.createStatsSection();
		this.container.appendChild(statsSection);

		// Data management
		const dataSection = this.createDataSection();
		this.container.appendChild(dataSection);
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

		return section;
	}

	/**
	 * Create control buttons section
	 */
	private createControlSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section buttons-section";

		// Pause/Resume button
		this.pauseButton = document.createElement("button");
		this.pauseButton.className = "btn btn-pause";
		this.pauseButton.textContent = "Pause";
		this.pauseButton.disabled = true;
		this.pauseButton.onclick = () => this.togglePause();
		section.appendChild(this.pauseButton);

		// Cancel button
		this.cancelButton = document.createElement("button");
		this.cancelButton.className = "btn btn-cancel";
		this.cancelButton.textContent = "Cancel";
		this.cancelButton.disabled = true;
		this.cancelButton.onclick = () => this.handleCancel();
		section.appendChild(this.cancelButton);

		// Clear button
		this.clearButton = document.createElement("button");
		this.clearButton.className = "btn btn-clear";
		this.clearButton.textContent = "Clear Data";
		this.clearButton.onclick = () => this.handleClear();
		section.appendChild(this.clearButton);

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
			"Enable Privacy Filter",
			false,
			(checked) => this.updatePrivacy({ enabled: checked }),
		);
		section.appendChild(privacyToggle);

		// Distance slider
		const distanceControl = document.createElement("div");
		distanceControl.className = "control-group";

		const distanceLabel = document.createElement("label");
		distanceLabel.textContent = "Remove Distance (m):";
		distanceLabel.htmlFor = "privacy-distance";
		distanceControl.appendChild(distanceLabel);

		const distanceInput = document.createElement("input");
		distanceInput.type = "range";
		distanceInput.id = "privacy-distance";
		distanceInput.min = "0";
		distanceInput.max = "500";
		distanceInput.value = "100";
		distanceInput.step = "25";

		const distanceValue = document.createElement("span");
		distanceValue.className = "value-display";
		distanceValue.textContent = "100m";

		distanceInput.oninput = () => {
			distanceValue.textContent = `${distanceInput.value}m`;
			this.updatePrivacy({ removeDistance: parseInt(distanceInput.value) });
		};

		distanceControl.appendChild(distanceInput);
		distanceControl.appendChild(distanceValue);
		section.appendChild(distanceControl);

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
			"Grid Cell Size (m):",
			10,
			100,
			25,
			5,
			(value) => this.updateConfig({ cellSize: value }),
		);
		content.appendChild(cellSizeControl);

		// Sampling step selector
		const samplingControl = this.createRangeControl(
			"sampling-step",
			"Sampling Step (m):",
			5,
			50,
			12.5,
			2.5,
			(value) => this.updateConfig({ samplingStep: value }),
		);
		content.appendChild(samplingControl);

		section.appendChild(content);
		return section;
	}

	/**
	 * Create route overlay section
	 */
	private createRouteSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section route-section collapsed";

		const header = document.createElement("div");
		header.className = "section-header";
		header.onclick = () => section.classList.toggle("collapsed");

		const title = document.createElement("h3");
		title.textContent = "Route Overlay";
		header.appendChild(title);

		const toggle = document.createElement("span");
		toggle.className = "toggle-icon";
		toggle.textContent = "▼";
		header.appendChild(toggle);

		section.appendChild(header);

		const content = document.createElement("div");
		content.className = "section-content";

		// Toggle visibility
		const visibilityToggle = this.createCheckbox("route-visible", "Show Routes", true, (checked) =>
			this.options.onRouteToggle?.(checked),
		);
		content.appendChild(visibilityToggle);

		// Line width control
		const widthControl = this.createRangeControl(
			"route-width",
			"Line Width:",
			1,
			5,
			2,
			0.5,
			(value) => this.options.onRouteStyleChange?.({ lineWidth: value }),
		);
		content.appendChild(widthControl);

		// Line opacity control
		const opacityControl = this.createRangeControl(
			"route-opacity",
			"Opacity:",
			0,
			1,
			0.7,
			0.1,
			(value) => this.options.onRouteStyleChange?.({ lineOpacity: value }),
		);
		content.appendChild(opacityControl);

		// Color by type toggle
		const colorByTypeToggle = this.createCheckbox(
			"route-color-type",
			"Color by Activity Type",
			true,
			(checked) => this.options.onRouteStyleChange?.({ colorByType: checked }),
		);
		content.appendChild(colorByTypeToggle);

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
    `;
		section.appendChild(this.statsContainer);

		return section;
	}

	/**
	 * Create data management section
	 */
	private createDataSection(): HTMLElement {
		const section = document.createElement("div");
		section.className = "control-section data-section";

		const title = document.createElement("h3");
		title.textContent = "Data Management";
		section.appendChild(title);

		// Export button
		const exportButton = document.createElement("button");
		exportButton.className = "btn btn-export";
		exportButton.textContent = "Export Data";
		exportButton.onclick = () => this.options.onExport?.();
		section.appendChild(exportButton);

		// Import button
		const importButton = document.createElement("button");
		importButton.className = "btn btn-import";
		importButton.textContent = "Import Data";
		importButton.onclick = () => this.handleImport();
		section.appendChild(importButton);

		return section;
	}

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
		input.value = value.toString();
		input.step = step.toString();

		const valueDisplay = document.createElement("span");
		valueDisplay.className = "value-display";
		valueDisplay.textContent = value.toString();

		input.oninput = () => {
			valueDisplay.textContent = input.value;
			onChange(parseFloat(input.value));
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
			const el = this.statsContainer.querySelector("#stat-area");
			if (el) el.textContent = `${stats.area.toFixed(2)} km²`;
		}
	}

	/**
	 * Set processing state
	 */
	setProcessing(processing: boolean): void {
		this.isProcessing = processing;

		if (this.pauseButton) {
			this.pauseButton.disabled = !processing;
		}

		if (this.cancelButton) {
			this.cancelButton.disabled = !processing;
		}
	}

	/**
	 * Toggle pause state
	 */
	private togglePause(): void {
		this.isPaused = !this.isPaused;

		if (this.pauseButton) {
			this.pauseButton.textContent = this.isPaused ? "Resume" : "Pause";
			this.pauseButton.classList.toggle("paused", this.isPaused);
		}

		if (this.isPaused) {
			this.options.onPause?.();
		} else {
			this.options.onResume?.();
		}
	}

	/**
	 * Handle cancel
	 */
	private handleCancel(): void {
		if (confirm("Are you sure you want to cancel processing?")) {
			this.options.onCancel?.();
			this.setProcessing(false);
			this.isPaused = false;
			if (this.pauseButton) {
				this.pauseButton.textContent = "Pause";
			}
		}
	}

	/**
	 * Handle clear data
	 */
	private handleClear(): void {
		if (confirm("Are you sure you want to clear all exploration data?")) {
			this.options.onClear?.();
			this.updateStats({ cells: 0, activities: 0, rectangles: 0, area: 0 });
			this.updateProgress(0, 0, "Cleared");
		}
	}

	/**
	 * Handle import
	 */
	private handleImport(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = () => {
			const file = input.files?.[0];
			if (file) {
				this.options.onImport?.(file);
			}
		};
		input.click();
	}

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
