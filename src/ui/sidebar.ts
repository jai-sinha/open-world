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
	private dtf: Intl.DateTimeFormat;
	private currentActivities: any[] = [];
	private static stylesInjected = false;

	constructor(container: HTMLElement, options: SidebarOptions = {}) {
		this.container = container;
		this.options = options;
		this.panel = document.createElement("div");
		this.content = document.createElement("div");
		// create locale-aware date/time formatter once for reuse
		this.dtf = new Intl.DateTimeFormat(undefined, {
			weekday: "short",
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZone: "UTC", // keeps activity's orig local time over client local time
		});
		this.initialize();
	}

	private initialize(): void {
		Sidebar.injectStyles();

		// Set class and append panel
		this.panel.className = "activity-sidebar";

		// Header
		const header = document.createElement("div");
		header.className = "activity-sidebar-header";

		const title = document.createElement("h2");
		title.className = "activity-sidebar-title";
		title.textContent = "Activities";

		const closeBtn = document.createElement("button");
		closeBtn.className = "activity-sidebar-close";
		closeBtn.innerHTML = "&times;";
		closeBtn.onclick = () => this.hide();

		header.appendChild(title);
		header.appendChild(closeBtn);
		this.panel.appendChild(header);

		// Content container
		this.content.className = "activity-sidebar-content";
		this.panel.appendChild(this.content);

		this.container.appendChild(this.panel);
	}

	private static injectStyles(): void {
		if (Sidebar.stylesInjected) return;

		const style = document.createElement("style");
		style.textContent = `
			.activity-sidebar {
				position: fixed;
				top: 0;
				right: -320px;
				width: 320px;
				height: 100%;
				background: white;
				box-shadow: -2px 0 8px rgba(0,0,0,0.1);
				z-index: 2000;
				transition: transform 0.3s ease;
				display: flex;
				flex-direction: column;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			}

			.activity-sidebar.visible {
				transform: translateX(-320px);
			}

			.activity-sidebar-header {
				padding: 16px;
				border-bottom: 1px solid #eee;
				display: flex;
				justify-content: space-between;
				align-items: center;
				background: #f8f9fa;
			}

			.activity-sidebar-title {
				margin: 0;
				font-size: 16px;
				font-weight: 600;
			}

			.activity-sidebar-close {
				background: none;
				border: none;
				font-size: 24px;
				cursor: pointer;
				color: #666;
				padding: 0 4px;
				line-height: 1;
			}

			.activity-sidebar-content {
				flex: 1;
				overflow-y: auto;
				padding: 0;
			}

			.activity-empty {
				padding: 16px;
				color: #666;
			}

			.activity-item {
				padding: 12px 16px;
				border-bottom: 1px solid #eee;
				transition: background 0.2s;
			}

			.activity-item:hover {
				background: #f5f5f5;
			}

			.activity-name {
				font-weight: 600;
				margin-bottom: 4px;
				color: #333;
			}

			.activity-meta {
				font-size: 13px;
				color: #666;
				display: flex;
				gap: 8px;
				align-items: center;
			}

			.activity-dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				display: inline-block;
			}

			.activity-date {
				font-size: 12px;
				color: #999;
				margin-top: 4px;
			}

			.activity-link {
				display: block;
				margin-top: 8px;
				font-size: 12px;
				color: #fc5200;
				text-decoration: none;
			}

			/* Mobile Responsiveness */
			@media (max-width: 768px) {
				.activity-sidebar {
					width: 100%;
					right: -100%;
				}

				.activity-sidebar.visible {
					transform: translateX(-100%);
				}
			}
		`;
		document.head.appendChild(style);
		Sidebar.stylesInjected = true;
	}

	show(features: any[]): void {
		this.currentActivities = features.map((f) => f.properties);
		this.renderContent();
		let title = this.panel.querySelector("h2");
		const n = this.currentActivities.length;
		if (title) {
			title.textContent = `${n} ${n === 1 ? "Activity" : "Activities"}`;
		}
		this.panel.classList.add("visible");
		this.visible = true;
	}

	hide(): void {
		this.panel.classList.remove("visible");
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
			empty.className = "activity-empty";
			empty.textContent = "No activities selected";
			this.content.appendChild(empty);
			return;
		}

		const list = document.createElement("div");

		this.currentActivities.forEach((activity) => {
			const item = document.createElement("div");
			item.className = "activity-item";

			// Format data
			const date = this.dtf.format(new Date(activity.date));

			const distance = this.options.imperialUnits
				? (activity.distance / 1609.344).toFixed(2) + " mi"
				: (activity.distance / 1000).toFixed(2) + " km";

			item.innerHTML = `
                <div class="activity-name">${activity.name}</div>
                <div class="activity-meta">
                    <span class="activity-dot" style="background: ${activity.color || "#fc5200"};"></span>
                    <span>${activity.type}</span>
                    <span>•</span>
                    <span>${distance}</span>
                </div>
                <div class="activity-date">${date}</div>
                ${
									activity.id
										? `<a href="https://www.strava.com/activities/${activity.id}" target="_blank" class="activity-link">View on Strava &rarr;</a>`
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
