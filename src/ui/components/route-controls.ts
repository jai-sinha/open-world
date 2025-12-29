import { ACTIVITY_COLORS } from "../../lib/route-layer";
import { createCheckbox, createRangeControl } from "./ui-utils";

export interface RouteControlsOptions {
	onRouteToggle?: (visible: boolean) => void;
	onUnitsToggle?: (imperial: boolean) => void;
	onRouteStyleChange?: (style: {
		lineWidth?: number;
		lineOpacity?: number;
		colorByType?: boolean;
	}) => void;
}

export class RouteControlsComponent {
	public element: HTMLElement;
	private legendContainer: HTMLElement;
	private legendList: HTMLElement;
	private options: RouteControlsOptions;

	constructor(options: RouteControlsOptions) {
		this.options = options;
		this.element = document.createElement("div");
		this.element.className = "control-section route-section";

		const header = document.createElement("div");
		header.className = "section-header";

		const title = document.createElement("h3");
		title.textContent = "Route Overlay";
		header.appendChild(title);

		this.element.appendChild(header);

		const content = document.createElement("div");
		content.className = "section-content";

		const togglesRow = document.createElement("div");
		togglesRow.style.display = "flex";
		togglesRow.style.gap = "1em";
		togglesRow.style.alignItems = "center";

		const visibilityToggle = createCheckbox(
			"route-visible",
			"Show Routes",
			true,
			(checked) => {
				this.options.onRouteToggle?.(checked);
				if (this.legendContainer) {
					if (checked) {
						this.legendContainer.style.display =
							this.legendList && this.legendList.childElementCount ? "" : "none";
					} else {
						this.legendContainer.style.display = "none";
					}
				}
			},
		);
		togglesRow.appendChild(visibilityToggle);

		const unitsToggle = createCheckbox("route-imperial", "Imperial Units", false, (checked) =>
			this.options.onUnitsToggle?.(checked),
		);
		togglesRow.appendChild(unitsToggle);

		content.appendChild(togglesRow);

		const widthControl = createRangeControl(
			"route-width",
			"Line Width:",
			1,
			5,
			4.5,
			0.5,
			(value) => this.options.onRouteStyleChange?.({ lineWidth: value }),
		);
		content.appendChild(widthControl);

		const opacityControl = createRangeControl(
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
		this.legendContainer = document.createElement("div");
		this.legendContainer.className = "control-group route-legend";
		this.legendContainer.style.display = "none";

		const legendTitle = document.createElement("label");
		legendTitle.textContent = "Activity Colors:";
		this.legendContainer.appendChild(legendTitle);

		this.legendList = document.createElement("div");
		this.legendList.className = "legend-items";
		this.legendList.style.display = "flex";
		this.legendList.style.flexWrap = "wrap";
		this.legendList.style.gap = "8px";
		this.legendList.style.marginTop = "6px";

		this.legendContainer.appendChild(this.legendList);
		content.appendChild(this.legendContainer);

		this.element.appendChild(content);
	}

	/**
	 * Update the route activity types shown in the legend.
	 * Pass an array of activity type strings (e.g. ['Run', 'Ride']).
	 * If the array is empty or no known types are present, the legend is hidden.
	 */
	public updateActivityTypes(types: string[]): void {
		if (!this.legendList || !this.legendContainer) return;

		const provided = new Set(types || []);

		// Keep known types in the defined order, only those present
		const knownOrder = Object.keys(ACTIVITY_COLORS).filter((k) => k !== "default");
		const presentKnown = knownOrder.filter((k) => provided.has(k));

		// Any unknown types should be shown with default color
		const unknowns = Array.from(provided).filter(
			(t) => !Object.prototype.hasOwnProperty.call(ACTIVITY_COLORS, t),
		);

		// Clear existing items
		this.legendList.innerHTML = "";

		if (presentKnown.length === 0 && unknowns.length === 0) {
			// Nothing to show
			this.legendContainer.style.display = "none";
			return;
		}

		// Show container only if the routes overlay is visible
		const routesVisible =
			(document.getElementById("route-visible") as HTMLInputElement | null)?.checked ?? true;
		this.legendContainer.style.display = routesVisible ? "" : "none";

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
			this.legendList.appendChild(item);
		};

		presentKnown.forEach((type) => {
			addItem(type, ACTIVITY_COLORS[type as keyof typeof ACTIVITY_COLORS]);
		});

		if (unknowns.length > 0) {
			addItem("default", ACTIVITY_COLORS.default);
		}
	}
}
