export interface LocationSearchOptions {
	onLocationSelect: (center: [number, number]) => void;
	onMessage: (msg: string, type: "info" | "error") => void;
}

export class LocationSearchComponent {
	public element: HTMLElement;
	private options: LocationSearchOptions;

	constructor(options: LocationSearchOptions) {
		this.options = options;
		this.element = document.createElement("div");
		this.element.className = "control-section location-section";

		const title = document.createElement("h3");
		title.textContent = "Jump to Location";
		this.element.appendChild(title);

		const inputGroup = document.createElement("div");
		inputGroup.className = "input-group";
		inputGroup.style.display = "flex";
		inputGroup.style.gap = "8px";
		inputGroup.style.marginBottom = "10px";

		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "City, Country, ZIP code...";
		input.style.flex = "1";
		input.style.padding = "4px";
		input.style.borderRadius = "4px";
		input.style.border = "1px solid #ccc";

		const button = document.createElement("button");
		button.textContent = "Go";
		button.style.padding = "4px 8px";
		button.style.cursor = "pointer";

		const handleSearch = async () => {
			const query = input.value.trim();
			if (!query) return;

			const originalText = button.textContent;
			button.disabled = true;
			button.textContent = "...";

			try {
				const response = await fetch(
					`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`,
				);
				const data = await response.json();

				if (data && data.length > 0) {
					const { lat, lon } = data[0];
					this.options.onLocationSelect([parseFloat(lon), parseFloat(lat)]);
				} else {
					this.options.onMessage("Location not found", "error");
				}
			} catch (e) {
				console.error("Search failed:", e);
				this.options.onMessage("Search failed", "error");
			} finally {
				button.disabled = false;
				button.textContent = originalText;
			}
		};

		button.onclick = handleSearch;
		input.onkeydown = (e) => {
			if (e.key === "Enter") handleSearch();
		};

		inputGroup.appendChild(input);
		inputGroup.appendChild(button);
		this.element.appendChild(inputGroup);
	}
}
