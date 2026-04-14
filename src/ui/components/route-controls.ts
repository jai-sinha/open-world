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
	onFromDateChange?: (fromDate: Date | null) => void;
	onToDateChange?: (toDate: Date | null) => void;
	activities?: Array<{ start_date_local: string }>;
}

export class RouteControlsComponent {
	public element: HTMLElement;
	private legendContainer: HTMLElement;
	private legendList: HTMLElement;
	private options: RouteControlsOptions;
	private routeVisible = true;

	private dateRangeContainer: HTMLElement;
	private dateRangeSummary: HTMLElement;
	private sliderTrack: HTMLElement;
	private sliderRange: HTMLElement;
	private fromHandle: HTMLElement;
	private toHandle: HTMLElement;
	private activityDates: Date[] = [];
	private fromIndex = 0;
	private toIndex = 0;

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

		const visibilityToggle = createCheckbox("route-visible", "Show Routes", true, (checked) => {
			this.routeVisible = checked;
			this.options.onRouteToggle?.(checked);
			if (this.legendContainer) {
				if (checked) {
					this.legendContainer.style.display =
						this.legendList && this.legendList.childElementCount ? "" : "none";
				} else {
					this.legendContainer.style.display = "none";
				}
			}
		});
		togglesRow.appendChild(visibilityToggle);

		const unitsToggle = createCheckbox("route-imperial", "Imperial Units", false, (checked) =>
			this.options.onUnitsToggle?.(checked),
		);
		togglesRow.appendChild(unitsToggle);

		content.appendChild(togglesRow);

		const widthControl = createRangeControl("route-width", "Line Width:", 1, 5, 4.5, 0.5, (value) =>
			this.options.onRouteStyleChange?.({ lineWidth: value }),
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

		this.dateRangeContainer = document.createElement("div");
		this.dateRangeContainer.className = "control-group range-group route-date-range";
		this.dateRangeContainer.style.display = "none";

		const dateRangeLabel = document.createElement("label");
		dateRangeLabel.textContent = "Activity Date Range:";
		this.dateRangeContainer.appendChild(dateRangeLabel);

		this.dateRangeSummary = document.createElement("span");
		this.dateRangeSummary.className = "value-display";
		dateRangeLabel.appendChild(this.dateRangeSummary);

		const sliderWrap = document.createElement("div");
		sliderWrap.className = "range-slider-wrap route-date-range-slider";

		this.sliderTrack = document.createElement("div");
		this.sliderTrack.className = "range-slider-track";
		sliderWrap.appendChild(this.sliderTrack);

		this.sliderRange = document.createElement("div");
		this.sliderRange.className = "range-slider-fill";
		this.sliderTrack.appendChild(this.sliderRange);

		this.fromHandle = this.createHandle();
		this.toHandle = this.createHandle();

		this.sliderTrack.appendChild(this.fromHandle);
		this.sliderTrack.appendChild(this.toHandle);

		this.fromHandle.addEventListener("pointerdown", (event) => this.startDrag(event, "from"));
		this.toHandle.addEventListener("pointerdown", (event) => this.startDrag(event, "to"));
		this.sliderTrack.addEventListener("pointerdown", (event) => this.handleTrackPointerDown(event));

		this.dateRangeContainer.appendChild(sliderWrap);
		content.appendChild(this.dateRangeContainer);

		this.updateActivities(this.options.activities ?? []);

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

	public updateActivities(activities: Array<{ start_date_local: string }>): void {
		this.activityDates = activities
			.map((activity) => new Date(activity.start_date_local))
			.filter((date) => !Number.isNaN(date.getTime()))
			.sort((a, b) => a.getTime() - b.getTime());

		if (this.activityDates.length === 0) {
			this.dateRangeContainer.style.display = "none";
			this.dateRangeSummary.textContent = "";
			this.options.onFromDateChange?.(null);
			this.options.onToDateChange?.(null);
			return;
		}

		this.fromIndex = 0;
		this.toIndex = this.activityDates.length - 1;
		this.dateRangeContainer.style.display = "";
		this.syncDateRangeUI();
	}

	private createHandle(): HTMLElement {
		const handle = document.createElement("div");
		handle.className = "range-slider-thumb";
		return handle;
	}

	private startDrag(event: PointerEvent, handle: "from" | "to"): void {
		event.preventDefault();
		event.stopPropagation();

		const onPointerMove = (moveEvent: PointerEvent) => {
			this.updateHandleFromPointer(moveEvent.clientX, handle);
		};

		const onPointerUp = () => {
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
		};

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
	}

	private handleTrackPointerDown(event: PointerEvent): void {
		if (this.activityDates.length === 0) return;

		const rect = this.sliderTrack.getBoundingClientRect();
		const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
		const clampedRatio = Math.max(0, Math.min(1, ratio));
		const maxIndex = Math.max(1, this.activityDates.length - 1);
		const targetIndex = Math.round(clampedRatio * maxIndex);

		const fromDistance = Math.abs(targetIndex - this.fromIndex);
		const toDistance = Math.abs(targetIndex - this.toIndex);
		const handle = fromDistance <= toDistance ? "from" : "to";

		this.updateHandleFromPointer(event.clientX, handle);
		this.startDrag(event, handle);
	}

	private updateHandleFromPointer(clientX: number, handle: "from" | "to"): void {
		if (this.activityDates.length === 0) return;

		const rect = this.sliderTrack.getBoundingClientRect();
		if (rect.width <= 0) return;

		const ratio = (clientX - rect.left) / rect.width;
		const clampedRatio = Math.max(0, Math.min(1, ratio));
		const maxIndex = Math.max(1, this.activityDates.length - 1);
		const nextIndex = Math.round(clampedRatio * maxIndex);

		if (handle === "from") {
			this.fromIndex = Math.min(nextIndex, this.toIndex);
		} else {
			this.toIndex = Math.max(nextIndex, this.fromIndex);
		}

		this.syncDateRangeUI();
	}

	private syncDateRangeUI(): void {
		if (this.activityDates.length === 0) return;

		const maxIndex = Math.max(1, this.activityDates.length - 1);
		const fromDate = this.startOfDay(this.activityDates[this.fromIndex]);
		const toDate = this.endOfDay(this.activityDates[this.toIndex]);

		// slightly inset handle so it's aligned w above items
		const r = 9; // handle radius (px), half of 18px handle width
		const fromFrac = this.fromIndex / maxIndex;
		const toFrac = this.toIndex / maxIndex;
		const pos = (frac: number) => `calc(${r}px + ${frac} * (100% - ${r * 2}px))`;

		this.fromHandle.style.left = pos(fromFrac);
		this.toHandle.style.left = pos(toFrac);
		this.sliderRange.style.left = pos(fromFrac);
		this.sliderRange.style.width = `calc(${toFrac - fromFrac} * (100% - ${r * 2}px))`;

		this.dateRangeSummary.textContent = `${fromDate.toLocaleDateString()} – ${toDate.toLocaleDateString()}`;
		this.options.onFromDateChange?.(fromDate);
		this.options.onToDateChange?.(toDate);
	}

	private startOfDay(date: Date): Date {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
	}

	private endOfDay(date: Date): Date {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
	}

	/**
	 * Update the route activity types shown in the legend.
	 * Pass an array of activity type strings (e.g. ['Run', 'Ride']).
	 * If the array is empty or no known types are present, the legend is hidden.
	 */
	public updateActivityTypes(types: string[]): void {
		if (!this.legendList || !this.legendContainer) return;

		const provided = new Set(types || []);

		const knownOrder = Object.keys(ACTIVITY_COLORS).filter((k) => k !== "default");
		const presentKnown = knownOrder.filter((k) => provided.has(k));

		const unknowns = Array.from(provided).filter(
			(t) => !Object.prototype.hasOwnProperty.call(ACTIVITY_COLORS, t),
		);

		this.legendList.innerHTML = "";

		if (presentKnown.length === 0 && unknowns.length === 0) {
			this.legendContainer.style.display = "none";
			return;
		}

		this.legendContainer.style.display = this.routeVisible ? "" : "none";

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
