import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_DIR = join(__dirname, "..", "dist");

const STRAVA_CLIENT_ID = Bun.env.STRAVA_CLIENT_ID || "";
const STRAVA_CLIENT_SECRET = Bun.env.STRAVA_CLIENT_SECRET || "";
const PORT = parseInt(Bun.env.PORT || "3000", 10);

interface TokenRequest {
	code?: string;
	refresh_token?: string;
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		// CORS headers - adjust as needed for production
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		// Handle OPTIONS preflight
		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// API: Get Strava client ID
		if (path === "/api/config" && req.method === "GET") {
			return new Response(JSON.stringify({ STRAVA_CLIENT_ID }), {
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		// API: Exchange OAuth code for token
		if (path === "/api/strava/token" && req.method === "POST") {
			try {
				const body = (await req.json()) as TokenRequest;

				if (!body.code) {
					return new Response(JSON.stringify({ error: "Code required" }), {
						status: 400,
						headers: { ...corsHeaders, "Content-Type": "application/json" },
					});
				}

				if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
					console.error("Missing Strava credentials in environment");
					return new Response(JSON.stringify({ error: "Server not configured" }), {
						status: 500,
						headers: { ...corsHeaders, "Content-Type": "application/json" },
					});
				}

				// Exchange authorization code for access token
				const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						client_id: STRAVA_CLIENT_ID,
						client_secret: STRAVA_CLIENT_SECRET,
						code: body.code,
						grant_type: "authorization_code",
					}),
				});

				if (!tokenResponse.ok) {
					const error = await tokenResponse.text();
					console.error("Strava token exchange failed:", error);
					return new Response(JSON.stringify({ error: "Token exchange failed" }), {
						status: tokenResponse.status,
						headers: { ...corsHeaders, "Content-Type": "application/json" },
					});
				}

				const tokenData = await tokenResponse.json();
				return new Response(JSON.stringify(tokenData), {
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("Token exchange error:", error);
				return new Response(JSON.stringify({ error: "Internal server error" }), {
					status: 500,
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				});
			}
		}

		// API: Refresh access token
		if (path === "/api/strava/refresh" && req.method === "POST") {
			try {
				const body = (await req.json()) as TokenRequest;

				if (!body.refresh_token) {
					return new Response(JSON.stringify({ error: "Refresh token required" }), {
						status: 400,
						headers: { ...corsHeaders, "Content-Type": "application/json" },
					});
				}

				if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
					console.error("Missing Strava credentials in environment");
					return new Response(JSON.stringify({ error: "Server not configured" }), {
						status: 500,
						headers: { ...corsHeaders, "Content-Type": "application/json" },
					});
				}

				const tokenResponse = await fetch("https://www.strava.com/oauth/token", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						client_id: STRAVA_CLIENT_ID,
						client_secret: STRAVA_CLIENT_SECRET,
						refresh_token: body.refresh_token,
						grant_type: "refresh_token",
					}),
				});

				if (!tokenResponse.ok) {
					const error = await tokenResponse.text();
					console.error("Strava token refresh failed:", error);
					return new Response(JSON.stringify({ error: "Token refresh failed" }), {
						status: tokenResponse.status,
						headers: { ...corsHeaders, "Content-Type": "application/json" },
					});
				}

				const tokenData = await tokenResponse.json();
				return new Response(JSON.stringify(tokenData), {
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				});
			} catch (error) {
				console.error("Token refresh error:", error);
				return new Response(JSON.stringify({ error: "Internal server error" }), {
					status: 500,
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				});
			}
		}

		// API: Health check
		if (path === "/api/health") {
			return new Response(
				JSON.stringify({
					status: "ok",
					configured: !!(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET),
					timestamp: new Date().toISOString(),
				}),
				{
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				},
			);
		}

		// Serve static files from ./dist
		try {
			// Root paths
			if (path === "/" || path === "/index.html") {
				const filePath = join(DIST_DIR, "index.html");
				const file = Bun.file(filePath);
				if (await file.exists()) {
					return new Response(file, {
						headers: {
							"Content-Type": "text/html",
							"Cache-Control": "no-cache, no-store, must-revalidate",
						},
					});
				}
			}

			// Static assets (JS, CSS, maps, fonts, images)
			if (path.match(/\.(js|css|map|svg|woff|woff2|png|jpg|jpeg|gif|ico)$/)) {
				const filePath = join(DIST_DIR, path);
				const file = Bun.file(filePath);
				if (await file.exists()) {
					const ext = path.split(".").pop() || "";
					const mimes: Record<string, string> = {
						js: "application/javascript; charset=utf-8",
						css: "text/css; charset=utf-8",
						map: "application/json",
						svg: "image/svg+xml",
						woff: "font/woff",
						woff2: "font/woff2",
						png: "image/png",
						jpg: "image/jpeg",
						jpeg: "image/jpeg",
						gif: "image/gif",
						ico: "image/x-icon",
					};
					// Cache static assets for 1 year, except source maps
					const cacheControl = ext === "map" ? "no-cache" : "public, max-age=31536000, immutable";
					return new Response(file, {
						headers: {
							"Content-Type": mimes[ext] || "application/octet-stream",
							"Cache-Control": cacheControl,
						},
					});
				}
			}

			// SPA fallback: any other path → index.html
			const indexPath = join(DIST_DIR, "index.html");
			const indexFile = Bun.file(indexPath);
			if (await indexFile.exists()) {
				return new Response(indexFile, {
					headers: {
						"Content-Type": "text/html",
						"Cache-Control": "no-cache, no-store, must-revalidate",
					},
				});
			}
		} catch (err) {
			console.error("Error serving static file:", err);
		}

		// 404 response
		return new Response("Not Found", { status: 404 });
	},
});

console.log(`✨ Open World production server`);
console.log(`🚀 Listening on http://localhost:${PORT}`);
console.log(`📁 Serving from ${DIST_DIR}`);
console.log(`🔐 Strava OAuth: ${STRAVA_CLIENT_ID ? "✓ Configured" : "✗ Not configured"}`);

export {};
