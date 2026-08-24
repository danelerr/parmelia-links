import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectNoWcagViolations } from "./accessibility";

async function openPreview(page: Page, testInfo: TestInfo, view = "") {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Meli UI lives in the client app");
	await page.goto(`/__design/meli${view ? `?view=${view}` : ""}`, { waitUntil: "domcontentloaded" });
	const desktopNotice = page.getByRole("dialog");
	if (await desktopNotice.isVisible().catch(() => false)) {
		await desktopNotice.getByRole("button").click();
	}
}

test("Home and Move keep the Meli UI geometry", async ({ page }, testInfo) => {
	await openPreview(page, testInfo);

	await expect(page.locator(".meli-balance-card-app")).toBeVisible();
	await expect(page.locator(".meli-quick-action")).toHaveCount(4);

	const homeStyle = await page.locator(".meli-balance-card-app").evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			borderRadius: style.borderRadius,
			borderWidth: style.borderTopWidth,
			boxShadow: style.boxShadow,
		};
	});
	expect(homeStyle.background).toBe("rgb(11, 11, 15)");
	expect(homeStyle.borderRadius).toBe("0px");
	expect(homeStyle.borderWidth).toBe("2px");
	expect(homeStyle.boxShadow).toContain("rgb(248, 82, 57)");

	const homeWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
	expect(homeWidth.document).toBeLessThanOrEqual(homeWidth.viewport + 1);
	await expectNoWcagViolations(page);

	await page.goto("/__design/meli?view=move", { waitUntil: "domcontentloaded" });
	await expect(page.locator(".meli-path-card-app")).toHaveCount(3);
	const pathStyle = await page.locator(".meli-path-card-app").first().evaluate((element) => {
		const style = getComputedStyle(element);
		return { borderRadius: style.borderRadius, borderWidth: style.borderTopWidth };
	});
	expect(pathStyle).toEqual({ borderRadius: "0px", borderWidth: "2px" });
	await expectNoWcagViolations(page);
});

test("Meli dialogs and buttons use the landing treatment", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "dialog");

	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const dialogStyle = await dialog.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			borderRadius: style.borderRadius,
			borderWidth: style.borderTopWidth,
			boxShadow: style.boxShadow,
		};
	});
	expect(dialogStyle.background).toBe("rgb(255, 253, 249)");
	expect(dialogStyle.borderRadius).toBe("0px");
	expect(dialogStyle.borderWidth).toBe("2px");
	expect(dialogStyle.boxShadow).toContain("rgb(159, 41, 46)");

	const primaryButton = page.getByRole("button", { name: "Confirmar envío" });
	const buttonStyle = await primaryButton.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			background: style.backgroundColor,
			borderRadius: style.borderRadius,
			borderWidth: style.borderTopWidth,
			boxShadow: style.boxShadow,
		};
	});
	expect(buttonStyle.background).toBe("rgb(248, 82, 57)");
	expect(buttonStyle.borderRadius).toBe("0px");
	expect(buttonStyle.borderWidth).toBe("2px");
	expect(buttonStyle.boxShadow).toContain("rgb(159, 41, 46)");
	await expectNoWcagViolations(page);
});

test("nested card form keeps text inputs and custom selectors interactive", async ({ page }, testInfo) => {
	await page.route("**/card/interest", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ interest: null }),
		});
	});
	await openPreview(page, testInfo);

	await page.getByRole("button", { name: /acceso anticipado|early access/i }).click();
	const formDialog = page.getByRole("dialog", { name: /GatoPago Card/i });
	await expect(formDialog).toBeVisible();

	const country = formDialog.getByRole("textbox", { name: /País|Country/i });
	await country.fill("Bolivia");
	await expect(country).toHaveValue("Bolivia");

	const useCase = formDialog.getByRole("button", { name: /usarías|use it/i });
	await useCase.click();
	const optionDialog = page.getByRole("dialog", { name: /usarías|use it/i });
	await expect(optionDialog).toBeVisible();
	await optionDialog.getByRole("option", { name: /Compras online|Online shopping/i }).click();

	await expect(useCase).toContainText(/Compras online|Online shopping/i);
	await expect(country).toHaveValue("Bolivia");
	await country.fill("Bolivia, La Paz");
	await expect(country).toHaveValue("Bolivia, La Paz");
	await expectNoWcagViolations(page);
});

test("profile name and social fields preserve user input across renders", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "profile");

	const displayName = page.getByRole("textbox", { name: /Nombre para mostrar|Display name/i });
	const socialUrl = page.getByRole("textbox", { name: /Red social|Social link/i });
	await expect(displayName).toBeVisible();
	await expect(socialUrl).toBeVisible();

	await displayName.fill("Daniel QA");
	await socialUrl.fill("https://example.com/daniel");
	await expect(displayName).toHaveValue("Daniel QA");
	await expect(socialUrl).toHaveValue("https://example.com/daniel");

	// A second state update catches effects that recreate profile data and reset
	// controlled fields after every keystroke.
	await displayName.fill("Daniel QA 2");
	await expect(displayName).toHaveValue("Daniel QA 2");
	await expect(socialUrl).toHaveValue("https://example.com/daniel");
	await expect(page.getByRole("button", { name: /Guardar|Save/i }).first()).toBeEnabled();
	await expectNoWcagViolations(page);
});
