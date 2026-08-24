import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectNoWcagViolations, tabTo } from "./accessibility";

async function openLogin(page: Page, testInfo: TestInfo) {
	const dashboard = testInfo.project.name.startsWith("dashboard");
	await page.goto(dashboard ? "/" : "/login", { waitUntil: "domcontentloaded" });

	const dialog = page.getByRole("dialog");
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole("button").click();
	}
}

test("login renders without overflow or runtime errors", async ({ page }, testInfo) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await openLogin(page, testInfo);

	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await expect(page.getByRole("button", { name: /Google/i })).toBeVisible();
	const emailButton = page.getByRole("button", { name: /correo|email/i }).first();
	await expect(emailButton).toBeVisible();

	const layout = await page.evaluate(() => ({
		viewportWidth: window.innerWidth,
		documentWidth: document.documentElement.scrollWidth,
		viewportHeight: window.innerHeight,
		documentHeight: document.documentElement.scrollHeight,
	}));
	expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
	expect(layout.documentHeight).toBeGreaterThanOrEqual(layout.viewportHeight);

	await emailButton.click();
	const emailInput = page.getByRole("textbox");
	await expect(emailInput).toBeVisible();
	await expect(emailInput).toHaveAttribute("autocomplete", "email");
	await emailInput.fill("qa-input-check@example.com");
	await expect(emailInput).toHaveValue("qa-input-check@example.com");

	const box = await emailInput.boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(layout.viewportWidth + 1);
	}

	await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true });
	expect(pageErrors).toEqual([]);
});

test("login respects each product focus treatment and stays keyboard-operable", async ({ page }, testInfo) => {
	await openLogin(page, testInfo);
	await expectNoWcagViolations(page);

	const googleButton = page.getByRole("button", { name: /Google/i });
	await tabTo(page, googleButton, 5);
	await expect(googleButton).toBeFocused();
	const focusStyle = await googleButton.evaluate((element) => {
		const style = getComputedStyle(element);
		return style.outlineStyle;
	});
	expect(focusStyle).not.toBe("none");

	await page.keyboard.press("Tab");
	const emailButton = page.getByRole("button", { name: /correo|email/i }).first();
	await expect(emailButton).toBeFocused();
	await page.keyboard.press("Enter");

	const emailInput = page.getByRole("textbox");
	await expect(emailInput).toBeVisible();
	await expectNoWcagViolations(page);
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	});
	await tabTo(page, emailInput, 5);
	await expect(emailInput).toBeFocused();
	const inputFocusStyle = await emailInput.evaluate((element) => getComputedStyle(element).outlineStyle);
	expect(inputFocusStyle).not.toBe("none");
});

test("dashboard notifications are accessible and dismissible", async ({ page }, testInfo) => {
	test.skip(!testInfo.project.name.startsWith("dashboard"), "Dashboard-only notification surface");
	await openLogin(page, testInfo);
	await page.getByRole("button", { name: /correo/i }).click();
	await page.getByRole("textbox", { name: /correo/i }).fill("qa@example");
	await page.getByRole("button", { name: /enviarme un enlace/i }).click();

	const alert = page.getByRole("alert");
	await expect(alert).toContainText("Escribe un correo válido");
	await alert.getByRole("button", { name: /cerrar notificación/i }).click();
	await expect(alert).toHaveCount(0);
});
