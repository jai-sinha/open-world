/**
 * Helper: Create checkbox control
 */
export function createCheckbox(
	id: string,
	label: string,
	checked: boolean,
	onChange: (checked: boolean) => void,
): HTMLElement {
	const control = document.createElement("div");
	control.className = "control-group checkbox-group";

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.id = id;
	checkbox.checked = checked;
	checkbox.onchange = () => onChange(checkbox.checked);

	const labelEl = document.createElement("label");
	labelEl.htmlFor = id;
	labelEl.textContent = label;

	control.appendChild(checkbox);
	control.appendChild(labelEl);

	return control;
}

/**
 * Helper: Create range control
 */
export function createRangeControl(
	id: string,
	label: string,
	min: number,
	max: number,
	value: number,
	step: number,
	onChange: (value: number) => void,
): HTMLElement {
	const control = document.createElement("div");
	control.className = "control-group range-group";

	const labelEl = document.createElement("label");
	labelEl.textContent = label;
	labelEl.htmlFor = id;
	control.appendChild(labelEl);

	const input = document.createElement("input");
	input.type = "range";
	input.id = id;
	input.min = min.toString();
	input.max = max.toString();
	input.step = step.toString();

	const valueDisplay = document.createElement("span");
	valueDisplay.className = "value-display";

	// ensure slider UI and numeric values stay aligned during inital render
	const clampValue = (raw: number): number => {
		if (Number.isNaN(raw)) return min;
		return Math.min(max, Math.max(min, raw));
	};

	const setInputValue = (raw: number): number => {
		const clamped = clampValue(raw);
		input.value = clamped.toString();
		valueDisplay.textContent = clamped.toString();
		return clamped;
	};

	setInputValue(value);

	input.oninput = () => {
		const clamped = setInputValue(parseFloat(input.value));
		onChange(clamped);
	};

	control.appendChild(input);
	control.appendChild(valueDisplay);

	return control;
}
