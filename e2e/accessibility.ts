import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

export async function expectNoWcagViolations(page: Page) {
	await page.addStyleTag({
		content: "*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	await page.evaluate(async () => document.fonts.ready);
	const results = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
		.analyze();
	const summary = results.violations.map(({ id, impact, nodes }) => ({
		id,
		impact,
		targets: nodes.map((node) => node.target),
	}));
	expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

export async function tabTo(page: Page, target: Locator, maxTabs = 12) {
	await expect(target).toBeVisible();
	for (let attempt = 0; attempt < maxTabs; attempt += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) break;
		await page.keyboard.press("Tab");
	}
	await expect(target).toBeFocused();
}
