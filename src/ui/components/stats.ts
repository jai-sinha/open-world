export class StatsComponent {
	public element: HTMLElement;

	private cellsEl: HTMLElement;
	private activitiesEl: HTMLElement;
	private distanceEl: HTMLElement;
	private areaEl: HTMLElement;
	private viewportEl: HTMLElement;

	private lastAreaKm2 = 0;
	private lastDistanceKm = 0;
	private imperialUnits = false;

	constructor() {
		this.element = document.createElement("div");
		this.element.className = "control-section stats-section";

		const title = document.createElement("h3");
		title.textContent = "Statistics";
		this.element.appendChild(title);

		const container = document.createElement("div");
		container.className = "stats-content";
		this.element.appendChild(container);

		this.cellsEl = this.addStatRow(container, "Cells Visited:", "0");
		this.activitiesEl = this.addStatRow(container, "Activities Processed:", "0");
		this.distanceEl = this.addStatRow(container, "Total Distance:", "0 km");
		this.areaEl = this.addStatRow(container, "Total Area Explored:", "0 km²");
		this.viewportEl = this.addStatRow(container, "Current Window Exploration:", "0%");
	}

	private addStatRow(container: HTMLElement, label: string, initialValue: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "stat-item";

		const labelEl = document.createElement("span");
		labelEl.className = "stat-label";
		labelEl.textContent = label;

		const valueEl = document.createElement("span");
		valueEl.className = "stat-value";
		valueEl.textContent = initialValue;

		row.appendChild(labelEl);
		row.appendChild(valueEl);
		container.appendChild(row);
		return valueEl;
	}

	public setUnits(imperial: boolean): void {
		this.imperialUnits = imperial;
		this.renderDistance();
		this.renderArea();
	}

	public updateStats(stats: {
		cells?: number;
		activities?: number;
		distance?: number;
		area?: number;
		viewportExplored?: number;
	}): void {
		if (stats.cells !== undefined) this.cellsEl.textContent = stats.cells.toLocaleString();
		if (stats.activities !== undefined) {
			this.activitiesEl.textContent = stats.activities.toLocaleString();
		}

		if (stats.distance !== undefined) {
			this.lastDistanceKm = stats.distance;
			this.renderDistance();
		}

		if (stats.area !== undefined) {
			this.lastAreaKm2 = stats.area;
			this.renderArea();
		}

		if (stats.viewportExplored !== undefined) {
			this.viewportEl.textContent =
				stats.viewportExplored === -1 ? "Zoom in!" : `${stats.viewportExplored.toFixed(2)}%`;
		}
	}

	private renderDistance(): void {
		if (this.imperialUnits) {
			this.distanceEl.textContent = `${(this.lastDistanceKm * 0.6213711922).toFixed(2)} mi`;
		} else {
			this.distanceEl.textContent = `${this.lastDistanceKm.toFixed(2)} km`;
		}
	}

	private renderArea(): void {
		if (this.imperialUnits) {
			this.areaEl.textContent = `${(this.lastAreaKm2 * 0.3861021585).toFixed(2)} mi²`;
		} else {
			this.areaEl.textContent = `${this.lastAreaKm2.toFixed(2)} km²`;
		}
	}
}
