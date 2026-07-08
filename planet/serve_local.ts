const LOCAL_PORT = 3456;
const PROXY_UPSTREAM = "https://tiles.jsinha.com";
const CITY_DATASET_DIR = "./planet/output/city-dataset";
const LOOKUP_DIR = "./planet/output/lookup";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
};

function serveFile(file: BunFile, mime: string, req: Request): Response {
	const range = req.headers.get("Range");
	const size = file.size;

	if (range && size > 0) {
		const match = range.match(/bytes=(\d+)-(\d*)/);
		if (match) {
			const start = parseInt(match[1], 10);
			const end = match[2] ? parseInt(match[2], 10) : size - 1;
			const partial = file.slice(start, end + 1);
			return new Response(partial, {
				status: 206,
				headers: {
					...CORS_HEADERS,
					"Content-Type": mime,
					"Content-Range": `bytes ${start}-${end}/${size}`,
					"Content-Length": String(end - start + 1),
					"Accept-Ranges": "bytes",
				},
			});
		}
	}

	return new Response(file, {
		headers: {
			...CORS_HEADERS,
			"Content-Type": mime,
			"Content-Length": String(size),
			"Accept-Ranges": "bytes",
		},
	});
}

const server = Bun.serve({
	port: LOCAL_PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		if (req.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		// city-dataset files — serve from local build
		if (path.startsWith("/city-dataset/")) {
			const filePath = CITY_DATASET_DIR + path.replace("/city-dataset", "");
			const file = Bun.file(filePath);
			if (await file.exists()) {
				const mime = path.endsWith(".bin") ? "application/octet-stream" : "application/json";
				return serveFile(file, mime, req);
			}
		}

		// world-lookup.pmtiles — serve from local lookup dir
		if (path === "/world-lookup.pmtiles") {
			const file = Bun.file(`${LOOKUP_DIR}/world-lookup.pmtiles`);
			if (await file.exists()) {
				return serveFile(file, "application/octet-stream", req);
			}
		}

		// Everything else (region PMTiles, cities/*, etc.) — proxy to tiles.jsinha.com
		try {
			const upstreamUrl = `${PROXY_UPSTREAM}${path}${url.search}`;
			const upstreamHeaders = new Headers();
			const range = req.headers.get("Range");
			if (range) upstreamHeaders.set("Range", range);
			const upstream = await fetch(upstreamUrl, { headers: upstreamHeaders });
			if (upstream.ok || upstream.status === 206) {
				const headers = new Headers(upstream.headers);
				headers.set("Access-Control-Allow-Origin", "*");
				return new Response(upstream.body, { status: upstream.status, headers });
			}
		} catch {}

		return new Response("Not found", { status: 404, headers: CORS_HEADERS });
	},
});

console.log(`Local dataset server running on http://localhost:${LOCAL_PORT}`);
console.log(`Proxying missing files to ${PROXY_UPSTREAM}`);
