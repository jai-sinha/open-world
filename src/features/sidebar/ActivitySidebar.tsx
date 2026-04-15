import { Offcanvas } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

interface SidebarActivity {
	id: number;
	name: string;
	type: string;
	distance: number;
	date: string;
	color?: string;
}

function isSidebarActivity(value: unknown): value is SidebarActivity {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "number" &&
		typeof candidate.name === "string" &&
		typeof candidate.type === "string" &&
		typeof candidate.distance === "number" &&
		typeof candidate.date === "string"
	);
}

function getSidebarActivity(feature: unknown): SidebarActivity | null {
	if (!feature || typeof feature !== "object") return null;

	const candidate = feature as { properties?: unknown };
	const value = candidate.properties ?? feature;

	return isSidebarActivity(value) ? value : null;
}

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
				{selectedActivities.map((feature) => {
					const activity = getSidebarActivity(feature);
					if (!activity) return null;

					return (
						<div key={activity.id} className="mb-3 pb-3 border-bottom">
							<div className="fw-bold mb-1">{activity.name}</div>
							<div className="d-flex align-items-center mb-1 small text-muted">
								<span
									className="d-inline-block rounded-circle me-1 shrink-0"
									style={{
										width: "10px",
										height: "10px",
										backgroundColor: activity.color || "#fc5200",
									}}
								/>
								<span>
									{activity.type} &bull; {formatDistance(activity.distance, imperialUnits)}
								</span>
							</div>
							<div className="small text-muted mb-1">
								{dateFormatter.format(new Date(activity.date))}
							</div>
							<a
								href={`https://www.strava.com/activities/${activity.id}`}
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
