import { Card, ProgressBar } from "react-bootstrap";
import { useApp } from "@/app/AppContext";
import type { CityStats as CityStatsItem } from "@/lib/geocoding/city-manager";

export default function CityStats() {
	const { cityStats, cityDiscoveryProgress, jumpToCity } = useApp();

	const isDiscovering = cityDiscoveryProgress > 0 && cityDiscoveryProgress < 100;

	return (
		<Card className="mx-1 mb-3">
			<Card.Header className="fw-semibold">Top Cities</Card.Header>
			<Card.Body>
				{isDiscovering && (
					<div className="mb-3">
						<small className="text-muted d-block mb-1">
							Processing cities: {Math.round(cityDiscoveryProgress)}%
						</small>
						<ProgressBar now={cityDiscoveryProgress} animated striped variant="info" />
					</div>
				)}

				{cityStats.length === 0 && !isDiscovering && (
					<p className="text-muted mb-0">No cities found</p>
				)}

				{cityStats.length > 0 && (
					<div>
						{cityStats.map((city: CityStatsItem) => {
							const shortName = city.displayName.split(",")[0];
							const hasCenter = !!city.center;

							return (
								<div key={city.cityId} className="mb-2">
									<div className="d-flex justify-content-between align-items-center mb-1">
										{hasCenter ? (
											<span
												role="button"
												className="fw-semibold text-primary"
												style={{ cursor: "pointer" }}
												onClick={() =>
													jumpToCity({
														center: [city.center!.lng, city.center!.lat],
														outline: city.outline,
													})
												}
											>
												{shortName}
											</span>
										) : (
											<span className="fw-semibold">{shortName}</span>
										)}
										<small className="text-muted">{city.percentage.toFixed(1)}%</small>
									</div>
									<ProgressBar now={city.percentage} variant="success" style={{ height: "6px" }} />
								</div>
							);
						})}
					</div>
				)}
			</Card.Body>
		</Card>
	);
}
