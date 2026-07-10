import { useState } from "react";
import { Card, Form, InputGroup, Button, Spinner } from "react-bootstrap";
import { useApp } from "@/app/AppContext";
import { WorldLookup } from "@/lib/geocoding/world-lookup";

let worldLookup: WorldLookup | null = null;

function getWorldLookup(baseUrl: string): WorldLookup | null {
	if (!worldLookup && baseUrl) {
		try {
			worldLookup = new WorldLookup(`${baseUrl}/world-lookup.pmtiles`);
		} catch {}
	}
	return worldLookup;
}

export default function LocationSearch() {
	const { jumpToCity, tilesBaseUrl } = useApp();
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);

	const handleSearch = async () => {
		const trimmed = query.trim();
		if (!trimmed) return;

		setSearching(true);
		try {
			const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(trimmed)}`;
			const res = await fetch(url);
			const data = await res.json();

			if (!Array.isArray(data) || data.length === 0) {
				return;
			}

			const { lon, lat } = data[0];
			const center: [number, number] = [parseFloat(lon), parseFloat(lat)];

			let outline: [number, number][][] | undefined;
			try {
				const lookup = getWorldLookup(tilesBaseUrl);
				if (lookup) {
					const result = await lookup.query(parseFloat(lat), parseFloat(lon));
					if (result?.osmId) {
						const outlineRes = await fetch(
							`${tilesBaseUrl}/city-dataset/outlines/${result.osmId}.json`,
						);
						if (outlineRes.ok) {
							const outlineData = await outlineRes.json();
							outline = outlineData.outlines;
						}
					}
				}
			} catch {}

			jumpToCity({ center, outline });
		} catch {
		} finally {
			setSearching(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSearch();
		}
	};

	return (
		<Card className="mx-1 mb-3 mt-1">
			<Card.Header className="fw-semibold">Jump to Location</Card.Header>
			<Card.Body>
				<InputGroup>
					<Form.Control
						type="text"
						placeholder="City, Country, ZIP code..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						disabled={searching}
					/>
					<Button variant="primary" onClick={handleSearch} disabled={searching || !query.trim()}>
						{searching ? (
							<Spinner animation="border" size="sm" role="status">
								<span className="visually-hidden">Searching...</span>
							</Spinner>
						) : (
							"Go"
						)}
					</Button>
				</InputGroup>
			</Card.Body>
		</Card>
	);
}
