import { useState, useCallback, useMemo, useEffect } from "react";
import ReactSlider from "react-slider";
import { Card, Form } from "react-bootstrap";
import { useApp } from "@/app/AppContext";
import { ACTIVITY_COLORS } from "@/lib/route-layer";
import type { StravaActivity } from "@/types";

function formatDate(date: Date): string {
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function startOfDay(date: Date): Date {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d;
}

function endOfDay(date: Date): Date {
	const d = new Date(date);
	d.setHours(23, 59, 59, 999);
	return d;
}

export default function RouteControls() {
	const {
		allActivities,
		routeVisible,
		setRouteVisible,
		imperialUnits,
		setImperialUnits,
		setRouteStyle,
		setFromDate,
		setToDate,
	} = useApp();

	const [lineWidth, setLineWidth] = useState(4.5);
	const [opacity, setOpacity] = useState(0.5);

	// Derive sorted unique activity dates
	const activityDates = useMemo((): Date[] => {
		if (allActivities.length === 0) return [];
		const dates = allActivities
			.map((a: StravaActivity) => new Date(a.start_date_local))
			.sort((a: Date, b: Date) => a.getTime() - b.getTime());
		return dates;
	}, [allActivities]);

	const maxIndex = Math.max(0, activityDates.length - 1);

	const [fromIndex, setFromIndex] = useState(0);
	const [toIndex, setToIndex] = useState(maxIndex);

	// Sync toIndex when activities change
	useEffect(() => {
		setFromIndex(0);
		setToIndex(maxIndex);
	}, [maxIndex]);

	const handleLineWidthChange = useCallback(
		(value: number) => {
			setLineWidth(value);
			setRouteStyle({ lineWidth: value });
		},
		[setRouteStyle],
	);

	const handleOpacityChange = useCallback(
		(value: number) => {
			setOpacity(value);
			setRouteStyle({ lineOpacity: value });
		},
		[setRouteStyle],
	);

	// Sync date filter to context
	const syncDates = useCallback(
		(from: number, to: number) => {
			if (activityDates.length === 0) return;
			setFromDate(startOfDay(activityDates[from]));
			setToDate(endOfDay(activityDates[to]));
		},
		[activityDates, setFromDate, setToDate],
	);

	// Activity type legend
	const activityTypesPresent = useMemo((): Array<{ type: string; color: string }> => {
		const typeSet = new Set<string>(allActivities.map((a: StravaActivity) => a.type));
		const knownTypes = Object.keys(ACTIVITY_COLORS).filter((k) => k !== "default");
		const present: Array<{ type: string; color: string }> = [];
		let hasOther = false;

		for (const t of typeSet) {
			if (knownTypes.includes(t)) {
				present.push({ type: t, color: ACTIVITY_COLORS[t] });
			} else {
				hasOther = true;
			}
		}

		if (hasOther) {
			present.push({ type: "Other", color: ACTIVITY_COLORS.default });
		}

		return present;
	}, [allActivities]);

	return (
		<Card className="mx-1 mb-3">
			<Card.Header className="fw-semibold">Route Overlay</Card.Header>
			<Card.Body>
				{/* Toggle row */}
				<div className="d-flex gap-3 mb-3">
					<Form.Check
						type="switch"
						id="route-visible-switch"
						label="Show Routes"
						checked={routeVisible}
						onChange={(e) => setRouteVisible(e.target.checked)}
					/>
					<Form.Check
						type="switch"
						id="imperial-units-switch"
						label="Imperial Units"
						checked={imperialUnits}
						onChange={(e) => setImperialUnits(e.target.checked)}
					/>
				</div>

				{/* Line Width */}
				<Form.Group className="mb-3">
					<Form.Label className="d-flex justify-content-between mb-1">
						<span>Line Width</span>
						<span className="text-muted">{lineWidth}</span>
					</Form.Label>
					<Form.Range
						min={1}
						max={5}
						step={0.5}
						value={lineWidth}
						onChange={(e) => handleLineWidthChange(parseFloat(e.target.value))}
					/>
				</Form.Group>

				{/* Opacity */}
				<Form.Group className="mb-3">
					<Form.Label className="d-flex justify-content-between mb-1">
						<span>Opacity</span>
						<span className="text-muted">{opacity}</span>
					</Form.Label>
					<Form.Range
						min={0}
						max={1}
						step={0.1}
						value={opacity}
						onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
					/>
				</Form.Group>

				{/* Date Range Slider */}
				{activityDates.length > 0 && (
					<Form.Group className="mb-3">
						<Form.Label className="mb-1">Date Range</Form.Label>
						<div className="text-muted small mb-2">
							{formatDate(activityDates[fromIndex])} &ndash; {formatDate(activityDates[toIndex])}
						</div>
						<DualRangeSlider
							min={0}
							max={maxIndex}
							fromValue={fromIndex}
							toValue={toIndex}
							onFromChange={(v) => {
								setFromIndex(v);
								syncDates(v, toIndex);
							}}
							onToChange={(v) => {
								setToIndex(v);
								syncDates(fromIndex, v);
							}}
						/>
					</Form.Group>
				)}

				{/* Activity Legend */}
				{allActivities.length > 0 && routeVisible && activityTypesPresent.length > 0 && (
					<div>
						<Form.Label className="mb-1">Activity Types</Form.Label>
						<div className="d-flex flex-wrap gap-2">
							{activityTypesPresent.map(({ type, color }) => (
								<span key={type} className="d-inline-flex align-items-center gap-1 small">
									<span
										className="rounded-circle d-inline-block"
										style={{
											width: "10px",
											height: "10px",
											backgroundColor: color,
										}}
									/>
									{type}
								</span>
							))}
						</div>
					</div>
				)}
			</Card.Body>
		</Card>
	);
}

/* ─── Dual-handle range slider ─── */

interface DualRangeSliderProps {
	min: number;
	max: number;
	fromValue: number;
	toValue: number;
	onFromChange: (v: number) => void;
	onToChange: (v: number) => void;
}

function DualRangeSlider({
	min,
	max,
	fromValue,
	toValue,
	onFromChange,
	onToChange,
}: DualRangeSliderProps) {
	const handleChange = useCallback(
		(values: readonly number[]) => {
			const [nextFrom, nextTo] = values;
			onFromChange(nextFrom);
			onToChange(nextTo);
		},
		[onFromChange, onToChange],
	);

	return (
		<div className="py-2">
			<ReactSlider
				className="position-relative dual-range-slider"
				min={min}
				max={max}
				value={[fromValue, toValue]}
				onChange={handleChange}
				pearling
				minDistance={0}
				ariaLabel={["Start date", "End date"]}
				ariaValuetext={(state: { valueNow: number }) => `Thumb value ${state.valueNow}`}
				renderTrack={(props: React.HTMLAttributes<HTMLDivElement>, state: { index: number }) => (
					<div
						{...props}
						className={`dual-range-slider-track position-absolute ${
							state.index === 1 ? "bg-primary" : "bg-secondary bg-opacity-25"
						}`}
					/>
				)}
				renderThumb={(
					props: React.HTMLAttributes<HTMLDivElement> & { style?: React.CSSProperties },
					state: { index: number },
				) => (
					<div
						{...props}
						className="dual-range-slider-thumb position-absolute bg-white border border-primary shadow-sm"
						aria-label={state.index === 0 ? "Start date" : "End date"}
					/>
				)}
			/>
		</div>
	);
}
