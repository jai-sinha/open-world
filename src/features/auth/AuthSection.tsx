import { Button } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

export default function AuthSection() {
	const { isAuthenticated, athlete, authorize, logout, fetchAndProcessActivities, isProcessing } =
		useApp();

	return (
		<div className="p-3">
			{!isAuthenticated ? (
				<Button variant="primary" className="w-100" onClick={authorize}>
					Connect Strava
				</Button>
			) : (
				<div className="d-flex flex-column gap-2">
					<Button variant="danger" className="w-100" onClick={logout}>
						Logout {athlete?.firstname} {athlete?.lastname}
					</Button>
					<Button
						variant="success"
						className="w-100"
						onClick={fetchAndProcessActivities}
						disabled={isProcessing}
					>
						{isProcessing ? "Loading…" : "Load Activities"}
					</Button>
				</div>
			)}
		</div>
	);
}
