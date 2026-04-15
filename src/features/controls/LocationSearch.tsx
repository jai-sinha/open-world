import { useState } from "react";
import { Card, Form, InputGroup, Button, Spinner } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

export default function LocationSearch() {
	const { jumpToLocation, showMessage } = useApp();
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
				showMessage("Location not found", "error");
				return;
			}

			const { lon, lat } = data[0];
			jumpToLocation([parseFloat(lon), parseFloat(lat)]);
		} catch {
			showMessage("Location not found", "error");
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
		<Card className="mx-3 mb-3">
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
