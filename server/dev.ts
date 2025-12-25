// Bun development server with Strava OAuth token exchange
// Handles both serving static files and OAuth endpoints

const STRAVA_CLIENT_ID = Bun.env.STRAVA_CLIENT_ID || "";
const STRAVA_CLIENT_SECRET = Bun.env.STRAVA_CLIENT_SECRET || "";
const PORT = parseInt(Bun.env.PORT || "3000", 10);

interface TokenRequest {
	code?: string;
	refresh_token?: string;
}

// Build at startup - run build script to create dist/
console.log("⏳ Building project...");
try {
	await import("../build");
	console.log("✅ Build complete: ./dist ready to serve");
} catch (e) {
	console.warn("⚠️  Build failed, will serve from public/ if available:", e);
}

const _server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		// CORS headers for development
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		// Handle OPTIONS preflight
		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// API Routes

		if (path === "/api/config" && req.method === "GET") {
			return new Response(JSON.stringify({ STRAVA_CLIENT_ID }), {
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

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
					return new Response(
						JSON.stringify({ error: "Server not configured with Strava credentials" }),
						{
							status: 500,
							headers: { ...corsHeaders, "Content-Type": "application/json" },
						},
					);
				}

				// Exchange code for token with Strava
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

		// Refresh token endpoint
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
					return new Response(
						JSON.stringify({ error: "Server not configured with Strava credentials" }),
						{
							status: 500,
							headers: { ...corsHeaders, "Content-Type": "application/json" },
						},
					);
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

		// Health check
		if (path === "/api/health") {
			return new Response(
				JSON.stringify({
					status: "ok",
					configured: !!(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET),
				}),
				{
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				},
			);
		}

		// Serve compiled assets from ./dist if available, otherwise fall back to ./public
		// Also support on-the-fly mapping of /src/*.ts requests to ./dist/*.js (dev-friendly)
		try {
			// Serve compiled JS for requests like /src/main.ts -> ./dist/main.js
			if (path.startsWith("/src/") && path.endsWith(".ts")) {
				const jsPath = "." + path.replace(/^\/src\//, "/dist/").replace(/\.ts$/, ".js");
				try {
					const fileCandidate = Bun.file(jsPath);
					if (await fileCandidate.exists()) {
						return new Response(fileCandidate, {
							headers: { "Content-Type": "application/javascript" },
						});
					}
				} catch {}
			}

			// Serve root-level files from dist (e.g., /main.js, /main.css)
			if (path.match(/^\/(main|worker)\.(js|css|map)$/)) {
				const distFile = Bun.file("./dist" + path);
				if (await distFile.exists()) {
					const ext = path.split(".").pop() || "";
					const mimes: Record<string, string> = {
						js: "application/javascript",
						map: "application/json",
						css: "text/css",
					};
					return new Response(distFile, {
						headers: { "Content-Type": mimes[ext] || "application/octet-stream" },
					});
				}
			}

			// Serve any file under /dist, /worker, or /data directories
			if (path.startsWith("/dist/") || path.startsWith("/worker/") || path.startsWith("/data/")) {
				// Map /worker/ requests to ./dist/worker/ since that's where the build output goes
				// Map /data/ requests to ./dist/data/ for city boundaries bundle
				let fpath = "." + path;
				if (path.startsWith("/worker/")) {
					fpath = "./dist" + path;
				} else if (path.startsWith("/data/")) {
					fpath = "./dist" + path;
				}
				try {
					const f = Bun.file(fpath);
					if (await f.exists()) {
						const ext = fpath.split(".").pop() || "";
						const mimes: Record<string, string> = {
							js: "application/javascript",
							map: "application/json",
							css: "text/css",
							html: "text/html",
							json: "application/json",
							gz: "application/gzip",
						};
						return new Response(f, {
							headers: { "Content-Type": mimes[ext] || "application/octet-stream" },
						});
					}
				} catch {}
			}

			// Serve index.html for root path
			if (path === "/" || path === "/index.html") {
				const distIndex = Bun.file("./dist/index.html");
				if (await distIndex.exists()) {
					return new Response(distIndex, {
						headers: { "Content-Type": "text/html" },
					});
				}

				// Fallback to public/index.html if dist not available
				const pubIndex = Bun.file("./public/index.html");
				return new Response(pubIndex, {
					headers: { "Content-Type": "text/html" },
				});
			}

			// OAuth callback route (just serve dist or public index.html, client will handle the code)
			if (path === "/auth/callback") {
				const distIndex = Bun.file("./dist/index.html");
				if (await distIndex.exists()) {
					return new Response(distIndex, { headers: { "Content-Type": "text/html" } });
				}
				const pubIndex = Bun.file("./public/index.html");
				return new Response(pubIndex, { headers: { "Content-Type": "text/html" } });
			}
		} catch (err) {
			console.error("Error while serving static asset:", err);
		}

		// 404 for other routes
		return new Response("Not Found", { status: 404 });
	},
});

console.log("🚀 Server running at http://localhost:" + PORT);
console.log("📍 OAuth callback: http://localhost:" + PORT + "");

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
	console.warn("⚠️  Warning: STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET not set!");
	console.warn("   Set these in a .env file or environment variables to enable OAuth.");
}

console.log(_server ? "Server started" : "Server error");

// Make this file a module (required for top-level await)
export {};
