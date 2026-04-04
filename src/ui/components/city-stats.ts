import type { CityStats } from "../../lib/geocoding/city-manager";

export class CityStatsComponent {
	public element: HTMLElement;

	private progressContainer: HTMLElement;
	private progressText: HTMLElement;
	private progressBarFill: HTMLElement;
	private listContainer: HTMLElement;

	private isDiscovering = false;
	private hasStats = false;

	constructor() {
		this.element = document.createElement("div");
		this.element.className = "control-section city-stats-section";

		const title = document.createElement("h3");
		title.textContent = "Top Cities";
		this.element.appendChild(title);

		const content = document.createElement("div");
		content.className = "city-stats";
		this.element.appendChild(content);

		// Progress bar — always in DOM, shown/hidden via .hidden
		this.progressContainer = document.createElement("div");
		this.progressContainer.hidden = true;

		this.progressText = document.createElement("div");
		this.progressText.className = "city-processing-text";

		const barBg = document.createElement("div");
		Object.assign(barBg.style, {
			height: "8px",
			backgroundColor: "#eee",
			borderRadius: "4px",
			overflow: "hidden",
			marginTop: "6px",
		});

		this.progressBarFill = document.createElement("div");
		Object.assign(this.progressBarFill.style, {
			height: "100%",
			width: "0%",
			backgroundColor: "#4CAF50",
			transition: "width 0.15s linear",
		});

		barBg.appendChild(this.progressBarFill);
		this.progressContainer.appendChild(this.progressText);
		this.progressContainer.appendChild(barBg);
		content.appendChild(this.progressContainer);

		this.listContainer = document.createElement("div");
		content.appendChild(this.listContainer);
	}

	public reset(): void {
		this.isDiscovering = false;
		this.hasStats = false;
		this.progressContainer.hidden = true;
		this.progressBarFill.style.width = "0%";
		this.listContainer.innerHTML = "";
	}

	public setDiscoveryProgress(percentage: number): void {
		if (percentage >= 100) {
			this.isDiscovering = false;
			this.progressContainer.hidden = true;
			return;
		}

		if (!this.isDiscovering) {
			this.isDiscovering = true;
			this.hasStats = false;
			this.listContainer.innerHTML = "";
		}

		this.progressContainer.hidden = false;
		this.progressText.textContent = `Processing cities: ${percentage.toFixed(0)}%`;
		this.progressBarFill.style.width = `${percentage}%`;
	}

	public setStats(cities: CityStats[], isFinal = false): void {
		if (this.isDiscovering && !isFinal) return;

		if (cities.length === 0) {
			if (!this.isDiscovering && !this.hasStats) {
				this.listContainer.innerHTML = '<div class="stat-item">No cities found</div>';
			}
			return;
		}

		this.listContainer.innerHTML = "";
		const list = document.createElement("div");
		list.className = "city-list";
		Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "8px" });

		cities.forEach((city) => list.appendChild(this.renderCityItem(city)));
		this.listContainer.appendChild(list);
		this.hasStats = true;

		if (isFinal) {
			this.isDiscovering = false;
			this.progressContainer.hidden = true;
		}
	}

	private renderCityItem(city: CityStats): HTMLElement {
		const item = document.createElement("div");
		item.className = "city-item";
		Object.assign(item.style, { display: "flex", flexDirection: "column", fontSize: "0.9em" });

		const header = document.createElement("div");
		Object.assign(header.style, {
			display: "flex",
			justifyContent: "space-between",
			marginBottom: "2px",
		});

		const name = document.createElement("span");
		name.textContent = city.displayName.split(",")[0];
		name.style.fontWeight = "500";
		if (city.center) {
			name.style.cursor = "pointer";
			name.title = "Jump to city";
			name.addEventListener("click", () => {
				window.dispatchEvent(
					new CustomEvent("city-jump", {
						detail: { lat: city.center!.lat, lng: city.center!.lng },
					}),
				);
			});
		}

		const pct = document.createElement("span");
		pct.textContent = `${city.percentage.toFixed(1)}%`;

		header.appendChild(name);
		header.appendChild(pct);

		const barBg = document.createElement("div");
		Object.assign(barBg.style, {
			height: "4px",
			backgroundColor: "#eee",
			borderRadius: "2px",
			overflow: "hidden",
		});

		const barFill = document.createElement("div");
		Object.assign(barFill.style, {
			height: "100%",
			width: `${city.percentage}%`,
			backgroundColor: "#4CAF50",
		});

		barBg.appendChild(barFill);
		item.appendChild(header);
		item.appendChild(barBg);
		return item;
	}
}
