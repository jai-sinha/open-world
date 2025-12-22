export interface SidebarOptions {
	imperialUnits?: boolean;
	onClose?: () => void;
}

export class Sidebar {
	private container: HTMLElement;
	private panel: HTMLElement;
	private content: HTMLElement;
	private options: SidebarOptions;
	private visible = false;
	private currentActivities: any[] = [];

	constructor(container: HTMLElement, options: SidebarOptions = {}) {
		this.container = container;
		this.options = options;
		this.panel = document.createElement("div");
		this.content = document.createElement("div");
		this.initialize();
	}

	private initialize(): void {
		// Styles for the panel
		this.panel.style.cssText = `
            position: fixed;
            top: 0;
            right: -320px; /* Start hidden */
            width: 320px;
            height: 100%;
            background: white;
            box-shadow: -2px 0 8px rgba(0,0,0,0.1);
            z-index: 2000; /* Above map controls */
            transition: right 0.3s ease;
            display: flex;
            flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `;

		// Header
		const header = document.createElement("div");
		header.style.cssText = `
            padding: 16px;
            border-bottom: 1px solid #eee;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #f8f9fa;
        `;

		const title = document.createElement("h2");
		title.className = "title";
		title.textContent = "Activities";
		title.style.cssText = "margin: 0; font-size: 16px; font-weight: 600;";

		const closeBtn = document.createElement("button");
		closeBtn.innerHTML = "&times;";
		closeBtn.style.cssText = `
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #666;
            padding: 0 4px;
            line-height: 1;
        `;
		closeBtn.onclick = () => this.hide();

		header.appendChild(title);
		header.appendChild(closeBtn);
		this.panel.appendChild(header);

		// Content container
		this.content.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 0;
        `;
		this.panel.appendChild(this.content);

		this.container.appendChild(this.panel);
	}

	show(features: any[]): void {
		this.currentActivities = features.map((f) => f.properties);
		this.renderContent();
		let title = this.panel.querySelector("h2");
		const n = this.currentActivities.length;
		if (title) {
			title.textContent = `${n} ${n === 1 ? "Activity" : "Activities"}`;
		}
		this.panel.style.right = "0";
		this.visible = true;
	}

	hide(): void {
		this.panel.style.right = "-320px";
		this.visible = false;
		if (this.options.onClose) this.options.onClose();
	}

	setUnits(imperial: boolean): void {
		this.options.imperialUnits = imperial;
		if (this.visible) {
			this.renderContent();
		}
	}

	private renderContent(): void {
		this.content.innerHTML = "";

		if (this.currentActivities.length === 0) {
			const empty = document.createElement("div");
			empty.textContent = "No activities selected";
			empty.style.padding = "16px";
			empty.style.color = "#666";
			this.content.appendChild(empty);
			return;
		}

		const list = document.createElement("div");

		this.currentActivities.forEach((activity) => {
			const item = document.createElement("div");
			item.style.cssText = `
                padding: 12px 16px;
                border-bottom: 1px solid #eee;
                transition: background 0.2s;
            `;
			item.onmouseenter = () => {
				item.style.background = "#f5f5f5";
			};
			item.onmouseleave = () => {
				item.style.background = "white";
			};

			// Format data
			const date = new Date(activity.date).toLocaleDateString(undefined, {
				weekday: "short",
				year: "numeric",
				month: "short",
				day: "numeric",
			});

			const distance = this.options.imperialUnits
				? (activity.distance / 1609.344).toFixed(2) + " mi"
				: (activity.distance / 1000).toFixed(2) + " km";

			item.innerHTML = `
                <div style="font-weight: 600; margin-bottom: 4px; color: #333;">${activity.name}</div>
                <div style="font-size: 13px; color: #666; display: flex; gap: 8px; align-items: center;">
                    <span style="background: ${activity.color || "#fc5200"}; width: 8px; height: 8px; border-radius: 50%; display: inline-block;"></span>
                    <span>${activity.type}</span>
                    <span>•</span>
                    <span>${distance}</span>
                </div>
                <div style="font-size: 12px; color: #999; margin-top: 4px;">${date}</div>
                ${
									activity.id
										? `<a href="https://www.strava.com/activities/${activity.id}" target="_blank" style="display: block; margin-top: 8px; font-size: 12px; color: #fc5200; text-decoration: none;">View on Strava &rarr;</a>`
										: ""
								}
            `;

			list.appendChild(item);
		});

		this.content.appendChild(list);
	}

	destroy(): void {
		this.panel.remove();
	}
}

export function createSidebar(container: HTMLElement, options?: SidebarOptions): Sidebar {
	return new Sidebar(container, options);
}
