export class StatsComponent {
	public element: HTMLElement;
	private statsContainer: HTMLElement;
	private areaStatEl: HTMLElement | null = null;
	private lastAreaKm2 = 0;
	private imperialUnits = false;

	constructor() {
		this.element = document.createElement("div");
		this.element.className = "control-section stats-section";

		const title = document.createElement("h3");
		title.textContent = "Statistics";
		this.element.appendChild(title);

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
        <span class="stat-label">Total Area Explored:</span>
        <span class="stat-value" id="stat-area">0 km²</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Current Window Exploration:</span>
        <span class="stat-value" id="stat-viewport">0%</span>
      </div>
    `;
		this.element.appendChild(this.statsContainer);

		// Keep a reference to the area element so we can update unit formatting
		this.areaStatEl = this.statsContainer.querySelector("#stat-area") as HTMLElement | null;
	}

	public setUnits(imperial: boolean): void {
		this.imperialUnits = imperial;
		this.updateAreaDisplay();
	}

	public updateStats(stats: {
		cells?: number;
		activities?: number;
		rectangles?: number;
		area?: number;
		viewportExplored?: number;
	}): void {
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
			this.lastAreaKm2 = stats.area;
			this.updateAreaDisplay();
		}

		if (stats.viewportExplored !== undefined) {
			const el = this.statsContainer.querySelector("#stat-viewport");
			if (el) {
				if (stats.viewportExplored === -1) {
					el.textContent = "Zoom in!";
				} else {
					el.textContent = `${stats.viewportExplored.toFixed(2)}%`;
				}
			}
		}
	}

	private updateAreaDisplay(): void {
		if (!this.areaStatEl) return;

		if (this.imperialUnits) {
			// convert km² to mi²
			const areaMi = this.lastAreaKm2 * 0.3861021585;
			this.areaStatEl.textContent = `${areaMi.toFixed(2)} mi²`;
		} else {
			this.areaStatEl.textContent = `${this.lastAreaKm2.toFixed(2)} km²`;
		}
	}
}
