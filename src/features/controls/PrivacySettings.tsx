import { useState } from "react";
import { Card, Form } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

export default function PrivacySettings() {
	const { config, updatePrivacySettings } = useApp();

	const [hideStartFinish, setHideStartFinish] = useState(config.privacyDistance > 0);
	const [skipPrivate, setSkipPrivate] = useState(config.skipPrivate);

	const handleHideToggle = (checked: boolean) => {
		setHideStartFinish(checked);
		updatePrivacySettings({
			enabled: checked,
			removeDistance: checked ? config.privacyDistance || 200 : 0,
			snapToGrid: config.snapToGrid,
			skipPrivateActivities: skipPrivate,
		});
	};

	const handleSkipPrivateToggle = (checked: boolean) => {
		setSkipPrivate(checked);
		updatePrivacySettings({
			enabled: hideStartFinish,
			removeDistance: hideStartFinish ? config.privacyDistance || 200 : 0,
			snapToGrid: config.snapToGrid,
			skipPrivateActivities: checked,
		});
	};

	return (
		<Card className="mx-3 mb-3">
			<Card.Header className="fw-semibold">Privacy Settings</Card.Header>
			<Card.Body>
				<Form.Check
					type="switch"
					id="privacy-hide-start-finish"
					label="Hide Route Start/Finish"
					checked={hideStartFinish}
					onChange={(e) => handleHideToggle(e.target.checked)}
					className="mb-2"
				/>
				<Form.Check
					type="switch"
					id="privacy-skip-private"
					label="Skip Private Activities"
					checked={skipPrivate}
					onChange={(e) => handleSkipPrivateToggle(e.target.checked)}
				/>
			</Card.Body>
		</Card>
	);
}
