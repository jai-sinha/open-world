import { Alert } from "react-bootstrap";
import { useApp } from "@/app/AppContext";

interface Message {
	id: string;
	text: string;
	type: "info" | "success" | "warning" | "error";
}

const variantMap: Record<string, string> = {
	info: "primary",
	success: "success",
	warning: "warning",
	error: "danger",
};

export default function Notifications() {
	const { messages } = useApp();

	if (messages.length === 0) return null;

	return (
		<div className="mx-3">
			<style>{`
        @keyframes notification-slide-in {
          0% {
            opacity: 0;
            transform: translateY(-1rem);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .notification-alert {
          animation: notification-slide-in 0.3s ease-out;
        }
      `}</style>
			{messages.map((msg: Message) => (
				<Alert
					key={msg.id}
					variant={variantMap[msg.type] || "primary"}
					className="notification-alert mb-2 py-2 px-3"
				>
					{msg.text}
				</Alert>
			))}
		</div>
	);
}
