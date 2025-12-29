export class ProgressComponent {
	public element: HTMLElement;
	private progressBar: HTMLProgressElement;
	private progressText: HTMLElement;

	constructor() {
		this.element = document.createElement("div");
		this.element.className = "control-section progress-section";
		this.element.style.display = "none"; // Hidden by default

		const title = document.createElement("h3");
		title.textContent = "Processing Progress";
		this.element.appendChild(title);

		// Progress bar
		this.progressBar = document.createElement("progress");
		this.progressBar.max = 100;
		this.progressBar.value = 0;
		this.element.appendChild(this.progressBar);

		// Progress text
		this.progressText = document.createElement("div");
		this.progressText.className = "progress-text";
		this.progressText.textContent = "Ready";
		this.element.appendChild(this.progressText);
	}

	public show(): void {
		this.element.style.display = "block";
		this.progressBar.value = 0;
		this.progressText.textContent = "Starting...";
	}

	public hide(): void {
		this.element.style.display = "none";
	}

	public update(percentage: number, text: string): void {
		this.progressBar.value = percentage;
		this.progressText.textContent = `${text} (${Math.round(percentage)}%)`;
	}
}
