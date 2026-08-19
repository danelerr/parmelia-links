import { expect, test, type Page } from "@playwright/test";
import { expectNoWcagViolations, tabTo } from "./accessibility";

async function dismissDesktopNotice(page: Page) {
	const dialog = page.getByRole("dialog");
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole("button").click();
		await expect(dialog).toBeHidden();
	}
}

test("public payment link is accessible and keyboard reachable", async ({ page }) => {
	await page.route("**/links/a11y-link", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				id: "a11y-link",
				amount: "12.50",
				currency: "USDC",
				reference: "Accessibility checkout",
				wallet: "0x00000000000000000000000000000000000000aa",
				status: "pending",
			}),
		});
	});

	await page.goto("/pay?id=a11y-link", { waitUntil: "domcontentloaded" });
	await dismissDesktopNotice(page);
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await expect(page.getByText("12.50")).toBeVisible();
	await expectNoWcagViolations(page);

	const signIn = page.getByRole("button", { name: /inicia|sign in/i });
	await tabTo(page, signIn);
	const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
	expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
});

test("cross-chain checkout is accessible and keyboard reachable", async ({ page }) => {
	await page.route("**/crosschain/inbound/config", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				enabled: true,
				sources: [
					{ chainId: 84532, name: "Base Sepolia", domain: 6 },
					{ chainId: 43113, name: "Avalanche Fuji", domain: 1 },
				],
			}),
		});
	});
	await page.route("**/user/a11y-user", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ walletAddress: "0x00000000000000000000000000000000000000bb" }),
		});
	});

	await page.goto("/cc/a11y-user", { waitUntil: "domcontentloaded" });
	await dismissDesktopNotice(page);
	await expect(page.getByRole("heading", { level: 1, name: "@a11y-user" })).toBeVisible();
	const networkTrigger = page.getByRole("button", { name: /red|network/i });
	await expect(networkTrigger).toBeVisible();
	await expectNoWcagViolations(page);
	await networkTrigger.click();
	const networkList = page.getByRole("listbox", { name: /red|network/i });
	await expect(networkList).toBeVisible();
	await networkList.getByRole("option", { name: "Avalanche Fuji" }).click();
	await expect(networkTrigger).toContainText("Avalanche Fuji");

	const amount = page.getByRole("textbox", { name: /monto|amount/i });
	await tabTo(page, amount);
	await amount.fill("12,5");
	await expect(amount).toHaveValue("12.5");
	await expect(page.getByRole("button", { name: /conectar|connect/i })).toBeEnabled();
	const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
	expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
});
