import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";
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

test("Home keeps Security directly accessible from the account menu", async ({ page }, testInfo) => {
	await openPreview(page, testInfo);

	await page.getByRole("button", { name: /Abrir menú|Open menu/i }).click();
	const securityLink = page.getByRole("link", { name: /^(Seguridad|Security)$/i });
	await expect(securityLink).toBeVisible();
	await expect(securityLink).toHaveAttribute("href", "/settings/security");
	await expectNoWcagViolations(page);
});

test("Home exposes an explicit balance refresh without background RPC polling", async ({ page }, testInfo) => {
	await openPreview(page, testInfo);

	const refresh = page.getByRole("button", {
		name: /^(Actualizar|Refresh)$/i,
	});
	await expect(refresh).toBeVisible();
	await expect(refresh).toBeEnabled();
	await expectNoWcagViolations(page);
});

test("Home keeps AVAX on Avalanche explicit and routes actions through that account", async ({ page }, testInfo) => {
	await openPreview(page, testInfo);

	await page.getByRole("button", { name: /Elegir moneda|Choose currency/i }).click();
	const assetDialog = page.getByRole("dialog", { name: /Elegir moneda|Choose currency/i });
	await assetDialog.getByRole("option", { name: /AVAX/i }).click();

	await expect(page.getByText(/AVAX · Avalanche Fuji/i)).toBeVisible();
	await expect(page.getByText("3.75", { exact: false })).toBeVisible();
	const send = page.getByRole("link", { name: /^(Enviar|Send)$/i });
	await expect(send).toHaveAttribute("href", "/send?chainKey=avalanche-fuji&asset=AVAX");
	await expect(page.getByRole("button", { name: /^(Cambiar|Swap)$/i })).toBeDisabled();

	await page.getByRole("button", { name: /Cuenta personal|Personal account/i }).click();
	const accountDialog = page.getByRole("dialog", {
		name: /Detalles técnicos|Detalles de la cuenta|Technical details|Account details/i,
	});
	await expect(accountDialog.getByText("Arbitrum Sepolia", { exact: true })).toBeVisible();
	await expect(accountDialog.getByText("Avalanche Fuji", { exact: true })).toBeVisible();
	const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
	expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
	await expectNoWcagViolations(page);
});

test("Receive deep link selects inactive Avalanche Fuji and exposes activation", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Meli UI lives in the client app");
	await page.goto(
		"/__design/meli?view=receive&chainKey=avalanche-fuji&asset=AVAX&inactiveFuji=1",
		{ waitUntil: "domcontentloaded" },
	);
	const desktopNotice = page.getByRole("dialog");
	if (await desktopNotice.isVisible().catch(() => false)) {
		await desktopNotice.getByRole("button").click();
	}

	await expect(page.getByRole("button", { name: /Activar Avalanche Fuji|Activate Avalanche Fuji/i })).toBeVisible();
	await expect(page.getByText(/AVAX|Avalanche Fuji/i).first()).toBeVisible();
	await expectNoWcagViolations(page);
});

test("Grow opened from Avalanche fails closed without loading the Arbitrum product", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Meli UI lives in the client app");
	let configRequests = 0;
	await page.route("**/earn/config**", async (route) => {
		configRequests += 1;
		await route.abort();
	});
	await page.goto("/__design/meli?view=earn-network-blocked&chainKey=avalanche-fuji", {
		waitUntil: "domcontentloaded",
	});
	const desktopNotice = page.getByRole("dialog");
	if (await desktopNotice.isVisible().catch(() => false)) {
		await desktopNotice.getByRole("button").click();
	}

	await expect(page.getByText(/Crecer no está disponible en Avalanche Fuji|Grow isn't available on Avalanche Fuji/i)).toBeVisible();
	await expect(page.getByText(/No cambiaremos tu red|We won't switch networks/i)).toBeVisible();
	await expect.poll(() => configRequests).toBe(0);
	await expect(page.getByRole("button", { name: /Continuar|Continue/i })).toHaveCount(0);
	await expectNoWcagViolations(page);
});

test("Home launches the native PWA prompt and then exposes reload", async ({ page }, testInfo) => {
	await openPreview(page, testInfo);
	await page.evaluate(() => {
		const target = window as Window & typeof globalThis & { __pwaPromptCalls?: number };
		target.__pwaPromptCalls = 0;
		const installEvent = new Event("beforeinstallprompt", { cancelable: true });
		Object.defineProperties(installEvent, {
			prompt: {
				value: async () => {
					target.__pwaPromptCalls = (target.__pwaPromptCalls ?? 0) + 1;
				},
			},
			userChoice: {
				value: Promise.resolve({ outcome: "accepted", platform: "web" }),
			},
		});
		window.dispatchEvent(installEvent);
	});

	await page.getByRole("button", { name: /Instalar GatoPago|Install GatoPago/i }).click();
	await expect.poll(() => page.evaluate(() => (
		window as Window & typeof globalThis & { __pwaPromptCalls?: number }
	).__pwaPromptCalls)).toBe(1);
	await expect(page.getByRole("button", { name: /Recargar GatoPago|Reload GatoPago/i })).toBeVisible();
});

test("an installed PWA keeps a working reload control", async ({ page }, testInfo) => {
	await page.addInitScript(() => {
		const nativeMatchMedia = window.matchMedia.bind(window);
		window.matchMedia = ((query: string) => {
			if (query !== "(display-mode: standalone)") return nativeMatchMedia(query);
			return {
				matches: true,
				media: query,
				onchange: null,
				addListener: () => undefined,
				removeListener: () => undefined,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
				dispatchEvent: () => true,
			} as MediaQueryList;
		}) as typeof window.matchMedia;
	});
	await openPreview(page, testInfo);

	const reload = page.getByRole("button", { name: /Recargar GatoPago|Reload GatoPago/i });
	await expect(reload).toBeVisible();
	const loaded = page.waitForEvent("domcontentloaded");
	await reload.click();
	await loaded;
	await expect(page.getByRole("button", { name: /Recargar GatoPago|Reload GatoPago/i })).toBeVisible();
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

test("security treats an unavailable status as unknown and blocks key changes", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security-error");

	const statusAlert = page.getByRole("alert");
	await expect(statusAlert).toContainText(/No pudimos verificar tu protección|couldn't verify your protection/i);
	await expect(page.getByText(/Estado no verificado|Status not verified/i)).toBeVisible();
	await expect(page.getByText(/Plan de respaldo sin verificar|Backup plan not verified/i)).toBeVisible();
	await expect(page.getByRole("button", { name: /Agregar passkey de respaldo|Add a backup passkey/i })).toBeDisabled();
	await expect(page.getByRole("button", { name: /Volver a comprobar|Check again/i })).toBeEnabled();
	await expectNoWcagViolations(page);

	await openPreview(page, testInfo, "security-chain-error");
	await expect(page.getByText(/Estado no verificado|Status not verified/i)).toBeVisible();
	await expect(page.getByText(/Plan de respaldo sin verificar|Backup plan not verified/i)).toBeVisible();
	await expect(page.getByRole("button", { name: /Agregar passkey de respaldo|Add a backup passkey/i })).toBeDisabled();
	await expect(page.getByRole("button", { name: /Quitar|Remove/i }).first()).toBeDisabled();
	await expectNoWcagViolations(page);
});

test("settings is the single entry point for keys and recovery", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "settings");

	const securityLink = page.getByRole("link", { name: /centro de seguridad|security center/i });
	await expect(securityLink).toBeVisible();
	await expect(securityLink).toHaveAttribute("href", "/settings/security");
	await expectNoWcagViolations(page);
});

test("back navigation replaces its parent and cannot bounce through route guards", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "settings");
	let historyLength = await page.evaluate(() => window.history.length);

	await page.getByRole("button", { name: /Atrás|Back/i }).click();
	await expect(page).toHaveURL(/\/login$/u);
	await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength);
	await page.waitForTimeout(250);
	await expect(page).toHaveURL(/\/login$/u);

	await openPreview(page, testInfo, "security");
	historyLength = await page.evaluate(() => window.history.length);
	await page.getByRole("link", { name: /^(Atrás|Back)$/i }).click();
	await expect(page).toHaveURL(/\/login$/u);
	await expect.poll(() => page.evaluate(() => window.history.length)).toBe(historyLength);
});

test("a missing signing key guides money flows to Settings instead of Recovery", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "passkey-guidance");
	await page.getByRole("button", { name: "Trigger passkey guidance" }).click();

	await expect(page.getByText(/No pudimos usar una llave|couldn't use a key/i)).toBeVisible();
	await expect(page.getByRole("button", { name: /Ir a Configuración|Open Settings/i })).toBeVisible();
	await expect(page.getByText(/Configuración → Seguridad|Settings → Security/i)).toBeVisible();
	await expectNoWcagViolations(page);
});

test("an account without a registered key shows the Security path on Home", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "home-no-keys");

	const securityLink = page.getByRole("link", { name: /Revisa tus llaves antes de pagar|Review your keys before paying/i });
	await expect(securityLink).toBeVisible();
	await expect(securityLink).toHaveAttribute("href", "/settings/security");
	await expect(page.getByText(/Configuración → Seguridad|Settings → Security/i)).toBeVisible();
	await expectNoWcagViolations(page);
});

test("security explains why the last active key cannot be removed", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security-single-key");

	const removeButton = page.getByRole("button", { name: /Quitar|Remove/i });
	await expect(removeButton).toBeDisabled();
	await expect(page.getByText(/última llave activa|last active key/i)).toBeVisible();
	await expectNoWcagViolations(page);
});

test("security never claims a synced passkey is missing from local browser metadata", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security");

	await expect(page.getByText(/No encontramos una llave guardada|did not find a key saved/i)).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Comprobar una llave|Check a key/i })).toBeVisible();
	await expect(page.getByText(/navegador no permite saber|browser cannot reveal/i)).toBeVisible();
	await expectNoWcagViolations(page);
});

test("security can remove keys across the previous Worker response during an atomic rollout", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security-compat");

	await expect(page.getByRole("button", { name: /Quitar|Remove/i })).toHaveCount(2);
	await expect(page.getByRole("button", { name: /Quitar|Remove/i }).first()).toBeEnabled();
	await expect(page.getByRole("button", { name: /Quitar|Remove/i }).nth(1)).toBeEnabled();
});

test("security never offers an onchain removal for an inactive registry credential", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security-inactive-key");

	await expect(page.getByRole("button", { name: /Quitar|Remove/i }).first()).toBeDisabled();
	await expect(page.getByText(/ya no es una llave activa|no longer an active account key/i)).toBeVisible();
	await expect(page.getByRole("button", { name: /Quitar|Remove/i }).nth(1)).toBeEnabled();
	await expectNoWcagViolations(page);
});

test("security discloses passkey storage, metadata, and physical-key options progressively", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security");

	await expect(page.getByRole("button", { name: /Agregar passkey de respaldo|Add a backup passkey/i })).toBeVisible();
	await expect(page.getByRole("button", { name: /Agregar llave física|Add a physical key/i })).toHaveCount(0);

	await page.getByRole("button", { name: /Dónde se guarda|Where is it stored/i }).click();
	const storageDialog = page.getByRole("dialog", { name: /Dónde vive tu passkey|Where your passkey lives/i });
	await expect(storageDialog).toContainText(/GatoPago no puede verla|GatoPago cannot see it/i);
	await storageDialog.getByRole("button", { name: /Cerrar|Close/i }).click();

	await page.getByRole("button", { name: /Otras opciones|Other options/i }).click();
	const optionsDialog = page.getByRole("dialog", { name: /Otra forma de guardar|Another way to store/i });
	await expect(optionsDialog.getByRole("button", { name: /Agregar llave física|Add a physical key/i })).toBeVisible();
	await optionsDialog.getByRole("button", { name: /Cancelar|Cancel/i }).click();

	await page.getByRole("button", { name: /Más información|More information/i }).first().click();
	const detailsDialog = page.getByRole("dialog", { name: /Información de esta llave|Information about this key/i });
	await expect(detailsDialog).toContainText("Google Password Manager");
	await expect(detailsDialog).toContainText("app.parmelia.me");
	await expectNoWcagViolations(page);
});

test("security accepts only same-origin return destinations", async ({ page }, testInfo) => {
	await openPreview(page, testInfo, "security&returnTo=%2Fpay%3Fid%3Dsafe-link");
	const returnLink = page.getByRole("link", { name: /Volver a la operación|Return to operation/i });
	await expect(returnLink).toHaveAttribute("href", "/pay?id=safe-link");

	for (const malicious of [
		"https%3A%2F%2Fevil.example",
		"%2F%2Fevil.example",
		"%2F%255Cevil.example",
	]) {
		await openPreview(page, testInfo, `security&returnTo=${malicious}`);
		await expect(page.getByRole("link", { name: /Volver a la operación|Return to operation/i })).toHaveCount(0);
	}
});

test("security signals only a complete credential inventory to the passkey manager", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Meli UI lives in the client app");
	await page.addInitScript(() => {
		const calls: Array<{ method: string; options: unknown }> = [];
		Object.defineProperty(window, "__passkeySignalCalls", { value: calls, configurable: true });
		if (typeof PublicKeyCredential === "undefined") return;
		Object.defineProperty(PublicKeyCredential, "signalCurrentUserDetails", {
			configurable: true,
			value: async (options: unknown) => { calls.push({ method: "current", options }); },
		});
		Object.defineProperty(PublicKeyCredential, "signalAllAcceptedCredentials", {
			configurable: true,
			value: async (options: unknown) => { calls.push({ method: "all", options }); },
		});
	});
	await openPreview(page, testInfo, "security");
	await expect.poll(async () => page.evaluate(() =>
		(window as unknown as { __passkeySignalCalls: Array<{ method: string }> })
			.__passkeySignalCalls.map((call) => call.method),
	)).toEqual(expect.arrayContaining(["current", "all"]));
	const inventory = await page.evaluate(() =>
		(window as unknown as {
			__passkeySignalCalls: Array<{ method: string; options: { allAcceptedCredentialIds?: string[] } }>;
		}).__passkeySignalCalls.find((call) => call.method === "all")?.options,
	);
	expect(inventory?.allAcceptedCredentialIds).toEqual([
		"preview-primary-key",
		"preview-backup-key",
	]);

	await openPreview(page, testInfo, "security-chain-error");
	await expect.poll(async () => page.evaluate(() =>
		(window as unknown as { __passkeySignalCalls: Array<{ method: string }> })
			.__passkeySignalCalls.map((call) => call.method),
	)).toContain("current");
	const degradedMethods = await page.evaluate(() =>
		(window as unknown as { __passkeySignalCalls: Array<{ method: string }> })
			.__passkeySignalCalls.map((call) => call.method),
	);
	expect(degradedMethods).not.toContain("all");
});

test("security requests the intended WebAuthn authenticator for each creation option", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Meli UI lives in the client app");
	await page.addInitScript(() => {
		Object.defineProperty(window, "__passkeyCreateOptions", { value: [], configurable: true });
		Object.defineProperty(navigator.credentials, "create", {
			configurable: true,
			value: async (options: CredentialCreationOptions) => {
				(window as unknown as { __passkeyCreateOptions: CredentialCreationOptions[] })
					.__passkeyCreateOptions.push(options);
				throw new DOMException("Test cancellation", "NotAllowedError");
			},
		});
	});
	await page.route("**/account/passkey/registration/preflight", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				registrationId: "test-registration",
				challenge: "AQIDBAUGBwgJCgsMDQ4PEA",
				rpId: "127.0.0.1",
				excludeCredentials: [{ id: "cHJldmlldy1wcmltYXJ5LWtleQ", transports: ["internal"] }],
			}),
		});
	});
	await openPreview(page, testInfo, "security");

	await page.getByRole("button", { name: /Agregar passkey de respaldo|Add a backup passkey/i }).click();
	await expect.poll(async () => page.evaluate(() =>
		(window as unknown as { __passkeyCreateOptions: CredentialCreationOptions[] })
			.__passkeyCreateOptions.length,
	)).toBe(1);
	let selection = await page.evaluate(() => {
		const options = (window as unknown as { __passkeyCreateOptions: Array<{
			publicKey?: PublicKeyCredentialCreationOptions & { hints?: string[] };
		}> }).__passkeyCreateOptions[0].publicKey;
		return {
			attachment: options?.authenticatorSelection?.authenticatorAttachment,
			hints: options?.hints,
			exclusions: options?.excludeCredentials?.length,
		};
	});
	expect(selection).toEqual({ attachment: "platform", hints: ["client-device"], exclusions: 1 });

	await page.getByRole("button", { name: /Otras opciones|Other options/i }).click();
	await page.getByRole("dialog", { name: /Otra forma de guardar|Another way to store/i })
		.getByRole("button", { name: /Agregar llave física|Add a physical key/i }).click();
	await expect.poll(async () => page.evaluate(() =>
		(window as unknown as { __passkeyCreateOptions: CredentialCreationOptions[] })
			.__passkeyCreateOptions.length,
	)).toBe(2);
	selection = await page.evaluate(() => {
		const options = (window as unknown as { __passkeyCreateOptions: Array<{
			publicKey?: PublicKeyCredentialCreationOptions & { hints?: string[] };
		}> }).__passkeyCreateOptions[1].publicKey;
		return {
			attachment: options?.authenticatorSelection?.authenticatorAttachment,
			hints: options?.hints,
			exclusions: options?.excludeCredentials?.length,
		};
	});
	expect(selection).toEqual({ attachment: "cross-platform", hints: ["security-key"], exclusions: 1 });
});

test("security explains a duplicate authenticator instead of exposing InvalidStateError", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Meli UI lives in the client app");
	let finalizeCalls = 0;
	await page.addInitScript(() => {
		Object.defineProperty(navigator.credentials, "create", {
			configurable: true,
			value: async () => {
				throw new DOMException("The object is in an invalid state", "InvalidStateError");
			},
		});
	});
	await page.route("**/account/passkey/registration/preflight", (route) => route.fulfill({
		status: 201,
		contentType: "application/json",
		body: JSON.stringify({
			registrationId: "duplicate-registration",
			challenge: "AQIDBAUGBwgJCgsMDQ4PEA",
			rpId: "127.0.0.1",
			excludeCredentials: [{ id: "cHJldmlldy1wcmltYXJ5LWtleQ", transports: ["internal"] }],
		}),
	}));
	await page.route("**/account/passkey", (route) => {
		if (route.request().method() === "PUT") finalizeCalls += 1;
		return route.continue();
	});
	await openPreview(page, testInfo, "security");

	await page.getByRole("button", { name: /Agregar passkey de respaldo|Add a backup passkey/i }).click();
	await expect(page.getByText(/gestor ya (?:tiene|protege) una llave (?:de esta|de la) cuenta|manager already (?:has|protects) (?:a|an) account key/i).first()).toBeVisible();
	await expect(page.getByText(/invalid state/i)).toHaveCount(0);
	expect(finalizeCalls).toBe(0);
});

test("security keeps failed rename and removal actions open for retry", async ({ page }, testInfo) => {
	await page.route("**/account/passkeys/**", async (route) => {
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: "Temporary failure", error_code: "SERVER_ERROR" }),
		});
	});
	await openPreview(page, testInfo, "security");

	await page.getByRole("button", { name: /Editar|Edit/i }).first().click();
	const keyName = page.getByRole("textbox", { name: /Nombre de la llave|Key name/i });
	await keyName.fill("Mi teléfono principal");
	const renameForm = page.locator("form").filter({ has: keyName });
	await renameForm.getByRole("button", { name: /Guardar|Save/i }).click();
	await expect(keyName).toHaveValue("Mi teléfono principal");
	await expect(renameForm.getByRole("alert")).toContainText(/nombre no cambió|name wasn't changed/i);

	await renameForm.getByRole("button", { name: /Cancelar|Cancel/i }).click();
	await page.getByRole("button", { name: /Quitar|Remove/i }).first().click();
	const removeDialog = page.getByRole("dialog", { name: /Quitar esta llave|Remove this key/i });
	await removeDialog.getByRole("button", { name: /Confirmar y quitar|Confirm and remove/i }).click();
	await expect(removeDialog).toBeVisible();
	await expect(removeDialog.getByRole("alert")).toContainText(/No se quitó ninguna llave|No key was removed/i);
	await expectNoWcagViolations(page);
});
