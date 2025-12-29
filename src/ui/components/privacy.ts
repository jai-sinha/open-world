import type { PrivacySettings } from "../../types";
import { createCheckbox } from "./ui-utils";

export interface PrivacyComponentOptions {
	onPrivacyChange: (settings: PrivacySettings) => void;
}

export class PrivacyComponent {
	public element: HTMLElement;
	private options: PrivacyComponentOptions;

	private currentSettings: PrivacySettings = {
		enabled: false,
		removeDistance: 100,
		snapToGrid: false,
		skipPrivateActivities: false,
	};

	constructor(options: PrivacyComponentOptions) {
		this.options = options;
		this.element = document.createElement("div");
		this.element.className = "control-section privacy-section";

		const title = document.createElement("h3");
		title.textContent = "Privacy Settings";
		this.element.appendChild(title);

		// Privacy toggle
		const privacyToggle = createCheckbox(
			"privacy-enabled",
			"Hide Route Start/Finish",
			this.currentSettings.enabled,
			(checked) => this.updateSettings({ enabled: checked }),
		);
		this.element.appendChild(privacyToggle);

		// Skip private activities
		const skipPrivate = createCheckbox(
			"skip-private",
			"Skip Private Activities",
			this.currentSettings.skipPrivateActivities,
			(checked) => this.updateSettings({ skipPrivateActivities: checked }),
		);
		this.element.appendChild(skipPrivate);
	}

	private updateSettings(partial: Partial<PrivacySettings>) {
		this.currentSettings = { ...this.currentSettings, ...partial };
		this.options.onPrivacyChange(this.currentSettings);
	}
}
