import { Card } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

interface StatRowProps {
	label: string;
	value: string;
}

function StatRow({ label, value }: StatRowProps) {
	return (
		<div className="d-flex justify-content-between align-items-center p-2 bg-light rounded mb-1">
			<span className="text-muted small">{label}</span>
			<span className="fw-semibold">{value}</span>
		</div>
	);
}

export default function Stats() {
	const { stats, imperialUnits } = useApp();

	const distance = imperialUnits
		? (stats.distance * 0.6213711922).toFixed(2) + " mi"
		: stats.distance.toFixed(2) + " km";

	const area = imperialUnits
		? (stats.area * 0.3861021585).toFixed(2) + " mi²"
		: stats.area.toFixed(2) + " km²";

	const viewportExplored =
		stats.viewportExplored === -1 ? "Zoom in!" : stats.viewportExplored.toFixed(2) + "%";

	return (
		<Card className="mx-1 mb-3">
			<Card.Header className="fw-semibold">Statistics</Card.Header>
			<Card.Body>
				<StatRow label="Cells Visited" value={stats.cells.toLocaleString()} />
				<StatRow label="Activities Processed" value={stats.activities.toLocaleString()} />
				<StatRow label="Total Distance" value={distance} />
				<StatRow label="Total Area Explored" value={area} />
				<StatRow label="Current Window Exploration" value={viewportExplored} />
			</Card.Body>
		</Card>
	);
}
