// Build script for bundling the application with Bun
// Handles TypeScript compilation and asset bundling

import { build } from "bun";
import { copyFile, mkdir, readdir } from "fs/promises";
import { join } from "path";

const outdir = "./dist";
const publicDir = "./public";

async function cleanDist() {
	console.log("🧹 Cleaning dist directory...");
	try {
		await Bun.$`rm -rf ${outdir}`;
	} catch {
		// Directory might not exist
	}
	await mkdir(outdir, { recursive: true });
}

async function copyPublicAssets() {
	console.log("📦 Copying public assets...");

	try {
		const files = await readdir(publicDir);

		for (const file of files) {
			if (file.endsWith(".html")) {
				await copyFile(join(publicDir, file), join(outdir, file));
				console.log(`  ✓ Copied ${file}`);
			}
		}

		// Copy data directory (city boundaries, etc.)
		try {
			await Bun.$`cp -r ${join(publicDir, "data")} ${join(outdir, "data")}`;
			console.log("  ✓ Copied data directory");
		} catch {
			console.warn("  ⚠ Data directory not found (optional)");
		}
	} catch (error) {
		console.warn("Warning: Could not copy public assets", error);
	}
}

async function buildApp() {
	console.log("🔨 Building application...");

	try {
		// Build main application
		const result = await build({
			entrypoints: ["./src/main.ts"],
			outdir,
			target: "browser",
			format: "esm",
			splitting: true,
			minify: true,
			sourcemap: "external",
			loader: {
				".ts": "ts",
				".css": "css",
			},
			external: [],
		});

		if (result.success) {
			console.log("  ✓ Main bundle created");
		} else {
			console.error("  ✗ Build failed:", result.logs);
			process.exit(1);
		}

		// Build worker separately
		const workerResult = await build({
			entrypoints: ["./src/worker/processor.ts"],
			outdir: join(outdir, "worker"),
			target: "browser",
			format: "esm",
			minify: true,
			sourcemap: "external",
			loader: {
				".ts": "ts",
			},
		});

		if (workerResult.success) {
			console.log("  ✓ Worker bundle created");
		} else {
			console.error("  ✗ Worker build failed:", workerResult.logs);
			process.exit(1);
		}
	} catch (error) {
		console.error("Build error:", error);
		process.exit(1);
	}
}

async function injectScripts() {
	console.log("🔧 Injecting script tags...");

	try {
		const htmlPath = join(outdir, "index.html");
		let html = await Bun.file(htmlPath).text();

		// Replace the module script tag with the bundled one
		html = html.replace(
			'<script type="module" src="/src/main.ts"></script>',
			'<script type="module" src="./main.js"></script>',
		);

		await Bun.write(htmlPath, html);
		console.log("  ✓ Updated index.html");
	} catch (error) {
		console.warn("Warning: Could not update HTML", error);
	}
}

async function generateStats() {
	console.log("📊 Generating build stats...");

	try {
		const files = await readdir(outdir);
		let totalSize = 0;

		for (const file of files) {
			const stat = await Bun.file(join(outdir, file)).size;
			totalSize += stat;
		}

		console.log(`  Total size: ${(totalSize / 1024).toFixed(2)} KB`);
	} catch (error) {
		console.warn("Could not generate stats");
	}
}

async function main() {
	console.log("🚀 Starting build process...\n");

	const startTime = Date.now();

	await cleanDist();
	await copyPublicAssets();
	await buildApp();
	await injectScripts();
	await generateStats();

	const duration = Date.now() - startTime;
	console.log(`\n✨ Build completed in ${duration}ms`);
	console.log(`📂 Output directory: ${outdir}`);
}

main().catch((error) => {
	console.error("Fatal build error:", error);
	process.exit(1);
});
