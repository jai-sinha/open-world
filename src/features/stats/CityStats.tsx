import { useState } from "react";
import { Button, Card, ProgressBar } from "react-bootstrap";
import { useApp } from "@/app/AppContext";
import type { CityStats as CityStatsItem } from "@/types";

const PAGE_SIZE = 10;

export default function CityStats() {
	const { cityStats, cityDiscoveryProgress, jumpToCity } = useApp();
	const [page, setPage] = useState(0);

	const isDiscovering = cityDiscoveryProgress > 0 && cityDiscoveryProgress < 100;
	const totalPages = Math.ceil(cityStats.length / PAGE_SIZE);
	const paged = cityStats.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
						{paged.map((city: CityStatsItem) => {
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

						{totalPages > 1 && (
							<div className="d-flex justify-content-between align-items-center mt-3">
								<Button
									size="sm"
									variant="outline-secondary"
									disabled={page === 0}
									onClick={() => setPage((p) => p - 1)}
								>
									Previous
								</Button>
								<small className="text-muted">
									{page + 1} / {totalPages}
								</small>
								<Button
									size="sm"
									variant="outline-secondary"
									disabled={page >= totalPages - 1}
									onClick={() => setPage((p) => p + 1)}
								>
									Next
								</Button>
							</div>
						)}
					</div>
				)}
			</Card.Body>
		</Card>
	);
}
