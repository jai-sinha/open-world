import { Offcanvas } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
	weekday: "short",
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZone: "UTC",
});

function formatDistance(meters: number, imperial: boolean): string {
	if (imperial) {
		return (meters / 1609.344).toFixed(2) + " mi";
	}
	return (meters / 1000).toFixed(2) + " km";
}

export default function ActivitySidebar() {
	const { sidebarOpen, closeSidebar, selectedActivities, imperialUnits } = useApp();

	const count = selectedActivities.length;
	const title = `${count} ${count === 1 ? "Activity" : "Activities"}`;

	return (
		<Offcanvas show={sidebarOpen} onHide={closeSidebar} placement="end" backdrop>
			<Offcanvas.Header closeButton>
				<Offcanvas.Title>{title}</Offcanvas.Title>
			</Offcanvas.Header>
			<Offcanvas.Body>
				{selectedActivities.map((feature: any) => {
					const p = feature.properties ?? feature;
					return (
						<div key={p.id} className="mb-3 pb-3 border-bottom">
							<div className="fw-bold mb-1">{p.name}</div>
							<div className="d-flex align-items-center mb-1 small text-muted">
								<span
									className="d-inline-block rounded-circle me-1 shrink-0"
									style={{
										width: "10px",
										height: "10px",
										backgroundColor: p.color || "#fc5200",
									}}
								/>
								<span>
									{p.type} &bull; {formatDistance(p.distance, imperialUnits)}
								</span>
							</div>
							<div className="small text-muted mb-1">{dateFormatter.format(new Date(p.date))}</div>
							<a
								href={`https://www.strava.com/activities/${p.id}`}
								target="_blank"
								rel="noopener noreferrer"
								className="small"
								style={{ color: "#fc5200" }}
							>
								View on Strava ↗
							</a>
						</div>
					);
				})}
			</Offcanvas.Body>
		</Offcanvas>
	);
}
