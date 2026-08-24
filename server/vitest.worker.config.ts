import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const serverRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			main: "./src/index.ts",
			wrangler: {
				configPath: "./wrangler.test.jsonc",
				environment: "runtime-test",
			},
			miniflare: {
				// The quarantined workerd build supports dates through 2026-07-08.
				// Production is five days newer but uses no compatibility-gated API
				// introduced in that interval.
				compatibilityDate: "2026-07-08",
				bindings: {
					RPC_URL: "https://rpc.example.invalid",
					PRIVATE_KEY: `0x${"01".repeat(32)}`,
					AUTH_CODE_PEPPER: "p".repeat(32),
					FIREBASE_PROJECT_ID: "runtime-test",
					FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
						project_id: "runtime-test",
						client_email: "runtime-test@example.iam.gserviceaccount.com",
						private_key: "runtime-test-only",
						token_uri: "https://oauth2.googleapis.com/token",
					}),
					FIREBASE_WEB_API_KEY: "runtime-test-key",
					AUTH_EMAIL_FROM: "runtime@example.com",
					TEST_MIGRATIONS: await readD1Migrations(`${serverRoot}migrations`),
				},
			},
		})),
	],
	test: {
		include: ["test-worker/**/*.test.ts"],
		setupFiles: ["./test-worker/setup.ts"],
	},
});
