import { useEffect, useState } from "react";
import { Card, ProgressBar as BSProgressBar } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

export default function ProgressSection() {
	const { isProcessing, progress } = useApp();
	const [visible, setVisible] = useState(false);
	const [fading, setFading] = useState(false);

	useEffect(() => {
		if (isProcessing || progress) {
			setVisible(true);
			setFading(false);
			return;
		}
		if (!visible) return;

		const timer = setTimeout(() => {
			setFading(true);
		}, 1000);
		const hideTimer = setTimeout(() => {
			setVisible(false);
			setFading(false);
		}, 1600);
		return () => {
			clearTimeout(timer);
			clearTimeout(hideTimer);
		};
	}, [isProcessing, progress, visible]);

	if (!visible) return null;

	const current = progress?.current ?? 0;
	const total = progress?.total ?? 1;
	const pct = total > 0 ? Math.round((current / total) * 100) : 0;
	const message = progress?.message ?? "Processing…";

	return (
		<div
			className={`mx-1 mb-3 ${fading ? "opacity-0" : "opacity-100"}`}
			style={{ transition: "opacity 0.5s ease-out" }}
		>
			<Card>
				<Card.Header className="fw-semibold">Processing Progress</Card.Header>
				<Card.Body>
					<BSProgressBar now={pct} label={`${pct}%`} animated={isProcessing} className="mb-2" />
					<small className="text-muted">{message}</small>
				</Card.Body>
			</Card>
		</div>
	);
}
