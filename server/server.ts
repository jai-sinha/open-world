import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_DIR = join(__dirname, "..", "dist");
const PUBLIC_DIR = join(__dirname, "..", "public");

const STRAVA_CLIENT_ID = Bun.env.STRAVA_CLIENT_ID || "";
const STRAVA_CLIENT_SECRET = Bun.env.STRAVA_CLIENT_SECRET || "";
const GEOAPIFY_KEY = Bun.env.GEOAPIFY_KEY || "";
const PORT = parseInt(Bun.env.PORT || "3000", 10);

// Check for production flag
const args = Bun.argv;
const isProduction = args.includes("--prod") || Bun.env.NODE_ENV === "production";

interface TokenRequest {
	code?: string;
	refresh_token?: string;
}

// Build at startup if not in production
if (!isProduction) {
	console.log("⏳ Building project...");
	try {
		await import("../build");
		console.log("✅ Build complete: ./dist ready to serve");
	} catch (e) {
		console.warn("⚠️  Build failed, will serve from public/ if available:", e);
	}
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		// CORS headers
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

		if (path === "/api/geoapify/key" && req.method === "GET") {
			return new Response(JSON.stringify({ key: GEOAPIFY_KEY }), {
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		// Token exchange endpoint
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
					environment: isProduction ? "production" : "development",
					timestamp: new Date().toISOString(),
				}),
				{
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				},
			);
		}

		// Static File Serving
		try {
			// 1. Check if file exists in DIST_DIR
			let filePath = join(DIST_DIR, path === "/" ? "index.html" : path);
			let file = Bun.file(filePath);
			let exists = await file.exists();

			// 2. Fallback to PUBLIC_DIR if not in production and not found in dist
			if (!exists && !isProduction) {
				const publicPath = join(PUBLIC_DIR, path === "/" ? "index.html" : path);
				const publicFile = Bun.file(publicPath);
				if (await publicFile.exists()) {
					file = publicFile;
					exists = true;
				}
			}

			// 3. SPA Fallback (serve index.html)
			if (!exists) {
				// If it looks like an asset request, return 404
				if (path.match(/\.(js|css|map|svg|woff|woff2|png|jpg|jpeg|gif|ico|json)$/)) {
					return new Response("Not Found", { status: 404 });
				}

				// Otherwise serve index.html
				filePath = join(DIST_DIR, "index.html");
				file = Bun.file(filePath);
				exists = await file.exists();

				if (!exists && !isProduction) {
					filePath = join(PUBLIC_DIR, "index.html");
					file = Bun.file(filePath);
					exists = await file.exists();
				}
			}

			if (exists) {
				const ext = filePath.split(".").pop() || "";
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
					html: "text/html",
					json: "application/json",
				};

				// Cache control
				let cacheControl = "no-cache"; // Default for dev
				if (isProduction) {
					if (ext === "html" || ext === "map") {
						cacheControl = "no-cache, no-store, must-revalidate";
					} else {
						cacheControl = "public, max-age=31536000, immutable";
					}
				}

				return new Response(file, {
					headers: {
						"Content-Type": mimes[ext] || "application/octet-stream",
						"Cache-Control": cacheControl,
					},
				});
			}
		} catch (err) {
			console.error("Error serving static file:", err);
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`✨ Open World Server (${isProduction ? "Production" : "Development"})`);
console.log(`🚀 Listening on http://localhost:${PORT}`);
if (!isProduction) console.log(`📁 Serving from ${DIST_DIR} (with fallback to public)`);
else console.log(`📁 Serving from ${DIST_DIR}`);
