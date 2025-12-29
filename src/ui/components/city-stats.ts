import type { CityStats } from "../../lib/geocoding/city-manager";

export class CityStatsComponent {
	public element: HTMLElement;
	private progressContainer: HTMLElement;
	private listContainer: HTMLElement;

	// Progress UI elements
	private processingText?: HTMLElement;
	private processingBarBg?: HTMLElement;
	private processingBarFill?: HTMLElement;

	constructor() {
		this.element = document.createElement("div");
		this.element.className = "control-section city-stats-section";

		const title = document.createElement("h3");
		title.textContent = "Top Cities";
		this.element.appendChild(title);

		const content = document.createElement("div");
		content.className = "city-stats";
		this.element.appendChild(content);

		this.progressContainer = document.createElement("div");
		content.appendChild(this.progressContainer);

		this.listContainer = document.createElement("div");
		content.appendChild(this.listContainer);
	}

	public showProgress(current: number, total: number): void {
		// If no cities to process, show empty message
		if (total === 0) {
			this.listContainer.innerHTML = '<div class="stat-item">No cities found</div>';
			this.clearProgress();
			return;
		}

		// When finished or current >= total, clear processing flag
		if (current >= total) {
			this.clearProgress();
			return;
		}

		// Create the UI if not already present
		if (!this.processingText || !this.processingBarBg || !this.processingBarFill) {
			this.progressContainer.innerHTML = "";
			const text = document.createElement("div");
			text.className = "city-processing-text";
			this.processingText = text;

			const barBg = document.createElement("div");
			barBg.style.height = "8px";
			barBg.style.backgroundColor = "#eee";
			barBg.style.borderRadius = "4px";
			barBg.style.overflow = "hidden";
			barBg.style.marginTop = "6px";

			const barFill = document.createElement("div");
			barFill.style.height = "100%";
			barFill.style.width = "0%";
			barFill.style.backgroundColor = "#4CAF50";
			barFill.style.transition = "width 0.15s linear";

			barBg.appendChild(barFill);

			this.processingBarBg = barBg;
			this.processingBarFill = barFill;

			this.progressContainer.appendChild(this.processingText);
			this.progressContainer.appendChild(barBg);
		}

		this.processingText.textContent = `Processing cities: ${current} / ${total}`;
		const pct = total > 0 ? (current / total) * 100 : 0;
		if (this.processingBarFill) {
			this.processingBarFill.style.width = `${pct}%`;
		}
	}

	public updateStats(stats: any[]): void {
		// Handle discovery sentinel (CityManager may return a progress stat while discovering)
		if (stats.length === 1 && stats[0].cityId === "processing") {
			this.showProgress(stats[0].visitedCount, stats[0].totalCells);
			return;
		}

		if (stats.length === 0) {
			this.listContainer.innerHTML = '<div class="stat-item">No cities found</div>';
			return;
		}

		this.listContainer.innerHTML = "";
		const list = document.createElement("div");
		list.className = "city-list";
		list.style.display = "flex";
		list.style.flexDirection = "column";
		list.style.gap = "8px";

		stats.forEach((city: CityStats) => {
			const item = document.createElement("div");
			item.className = "city-item";
			item.style.display = "flex";
			item.style.flexDirection = "column";
			item.style.fontSize = "0.9em";

			const header = document.createElement("div");
			header.style.display = "flex";
			header.style.justifyContent = "space-between";
			header.style.marginBottom = "2px";

			const name = document.createElement("span");
			name.textContent = city.displayName.split(",")[0]; // Just city name
			name.style.fontWeight = "500";

			const pct = document.createElement("span");
			pct.textContent = `${city.percentage.toFixed(1)}%`;

			header.appendChild(name);
			header.appendChild(pct);

			const barBg = document.createElement("div");
			barBg.style.height = "4px";
			barBg.style.backgroundColor = "#eee";
			barBg.style.borderRadius = "2px";
			barBg.style.overflow = "hidden";

			const barFill = document.createElement("div");
			barFill.style.height = "100%";
			barFill.style.width = `${city.percentage}%`;
			barFill.style.backgroundColor = "#4CAF50";

			barBg.appendChild(barFill);
			item.appendChild(header);
			item.appendChild(barBg);
			list.appendChild(item);
		});

		this.listContainer.appendChild(list);
	}

	private clearProgress() {
		this.progressContainer.innerHTML = "";
		this.processingText = undefined;
		this.processingBarBg = undefined;
		this.processingBarFill = undefined;
	}
}
