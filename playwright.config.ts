import { defineConfig, devices } from "@playwright/test";

const localChrome = process.env.CI ? {} : { channel: "chrome" as const };

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	outputDir: "test-results",
	use: {
		...localChrome,
		reducedMotion: "reduce",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: [
		{
			command: "pnpm --filter client dev --host 127.0.0.1 --port 4173 --strictPort",
			url: "http://127.0.0.1:4173/login",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		{
			command: "pnpm --filter dashboard dev --host 127.0.0.1 --port 4174 --strictPort",
			url: "http://127.0.0.1:4174",
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
	],
	projects: [
		{
			name: "client-desktop",
			use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1440, height: 900 } },
		},
		{
			name: "client-mobile",
			use: { ...devices["Pixel 7"], ...localChrome, baseURL: "http://127.0.0.1:4173", browserName: "chromium" },
		},
		{
			name: "dashboard-desktop",
			testIgnore: /money-flows\.accessibility\.spec\.ts/,
			use: { baseURL: "http://127.0.0.1:4174", viewport: { width: 1440, height: 900 } },
		},
		{
			name: "dashboard-mobile",
			testIgnore: /money-flows\.accessibility\.spec\.ts/,
			use: { ...devices["Pixel 7"], ...localChrome, baseURL: "http://127.0.0.1:4174", browserName: "chromium" },
		},
	],
});
