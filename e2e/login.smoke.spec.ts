import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectNoWcagViolations, tabTo } from "./accessibility";

async function openLogin(page: Page, testInfo: TestInfo) {
	const dashboard = testInfo.project.name.startsWith("dashboard");
	await page.goto(dashboard ? "/" : "/login", { waitUntil: "domcontentloaded" });

	const dialog = page.getByRole("dialog");
	if (await dialog.isVisible().catch(() => false)) {
		await dialog.getByRole("button").click();
	}
}

async function mockFirebaseEmailLinkCompletion(
	page: Page,
	input: { email: string; oobCode: string; uid: string; failuresBeforeSuccess?: number },
): Promise<() => number> {
	const now = Math.floor(Date.now() / 1_000);
	let attempts = 0;
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const idToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({
		iss: "https://securetoken.google.com/proyecto-prueba-push-firebase",
		aud: "proyecto-prueba-push-firebase",
		auth_time: now,
		user_id: input.uid,
		sub: input.uid,
		iat: now,
		exp: now + 3_600,
		email: input.email,
		email_verified: true,
		firebase: { sign_in_provider: "emailLink", identities: { email: [input.email] } },
	})}.e2e`;
	await page.route("https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink**", async (route) => {
		attempts += 1;
		expect(route.request().postDataJSON()).toMatchObject({
			email: input.email,
			oobCode: input.oobCode,
		});
		if (attempts <= (input.failuresBeforeSuccess ?? 0)) {
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: { code: 503, message: "INTERNAL_ERROR" } }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				idToken,
				refreshToken: "e2e-refresh-token",
				expiresIn: "3600",
				localId: input.uid,
				email: input.email,
				isNewUser: false,
			}),
		});
	});
	await page.route("https://securetoken.googleapis.com/v1/token**", (route) => route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({
			access_token: idToken,
			refresh_token: "e2e-refresh-token",
			expires_in: "3600",
			token_type: "Bearer",
			user_id: input.uid,
			project_id: "proyecto-prueba-push-firebase",
		}),
	}));
	await page.route("https://identitytoolkit.googleapis.com/v1/accounts:lookup**", (route) => route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({
			users: [{
				localId: input.uid,
				email: input.email,
				emailVerified: true,
				providerUserInfo: [{ providerId: "password", email: input.email, rawId: input.email }],
				createdAt: String(Date.now()),
				lastLoginAt: String(Date.now()),
			}],
		}),
	}));
	return () => attempts;
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

test("consumer email login requests a Firebase magic link without codes", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Consumer App magic-link flow");
	await page.route("**/auth/email-link/request", async (route) => {
		expect(route.request().method()).toBe("POST");
		expect(route.request().postDataJSON()).toMatchObject({
			email: "qa@example.com",
			turnstileToken: "e2e-turnstile-token",
		});
		await route.fulfill({
			status: 202,
			contentType: "application/json",
			body: JSON.stringify({
				sent: true,
				resendAfterSeconds: 60,
			}),
		});
	});

	await openLogin(page, testInfo);
	await page.getByRole("button", { name: /correo|email/i }).first().click();
	await page.getByRole("textbox", { name: /correo|email/i }).fill("qa@example.com");
	await page.getByRole("button", { name: /enlace|link/i }).click();

	await expect(page.getByRole("heading", { name: /Revisa tu correo|Check your email/i })).toBeVisible();
	await expect(page.getByText("qa@example.com")).toBeVisible();
	await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveCount(0);
	const remembered = await page.evaluate(() => localStorage.getItem("gatopago:firebase-email-link:v1"));
	expect(JSON.parse(remembered ?? "null")).toMatchObject({
		email: "qa@example.com",
		purpose: "signin",
	});
});

test("a magic link opened on another device asks for the email instead of exposing it in the URL", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Consumer App magic-link flow");
	const continueUrl = encodeURIComponent("https://app.parmelia.me/login?flow=signin");
	await page.goto(`/login?mode=signIn&oobCode=e2e-code&apiKey=e2e-key&continueUrl=${continueUrl}`);
	const desktopNotice = page.getByRole("dialog");
	if (await desktopNotice.isVisible().catch(() => false)) {
		await desktopNotice.getByRole("button").click();
	}

	await expect(page.getByRole("heading", { name: /Confirma tu correo|Confirm your email/i })).toBeVisible();
	await expect(page.getByRole("textbox", { name: /correo|email/i })).toBeVisible();
	expect(new URL(page.url()).searchParams.has("email")).toBe(false);
});

test("a remembered magic link is consumed by Firebase and leaves the action URL", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Consumer App magic-link flow");
	await mockFirebaseEmailLinkCompletion(page, {
		email: "qa@example.com",
		oobCode: "e2e-complete",
		uid: "e2e-magic-link-user",
	});

	await openLogin(page, testInfo);
	await page.evaluate(() => localStorage.setItem("gatopago:firebase-email-link:v1", JSON.stringify({
		email: "qa@example.com",
		purpose: "signin",
		requestedAt: Date.now(),
	})));
	const continueUrl = encodeURIComponent("https://app.parmelia.me/login?flow=signin");
	await page.goto(`/login?mode=signIn&oobCode=e2e-complete&apiKey=e2e-key&continueUrl=${continueUrl}`);
	await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
	expect(new URL(page.url()).search).toBe("");
});

test("a transient Firebase failure can retry the same unconsumed magic link", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Consumer App magic-link flow");
	const attempts = await mockFirebaseEmailLinkCompletion(page, {
		email: "qa@example.com",
		oobCode: "e2e-retry",
		uid: "e2e-magic-link-retry-user",
		failuresBeforeSuccess: 1,
	});

	await openLogin(page, testInfo);
	await page.evaluate(() => localStorage.setItem("gatopago:firebase-email-link:v1", JSON.stringify({
		email: "qa@example.com",
		purpose: "signin",
		requestedAt: Date.now(),
	})));
	const continueUrl = encodeURIComponent("https://app.parmelia.me/login?flow=signin");
	await page.goto(`/login?mode=signIn&oobCode=e2e-retry&apiKey=e2e-key&continueUrl=${continueUrl}`);

	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByRole("heading", { name: /Confirma tu correo|Confirm your email/i })).toBeVisible();
	await page.getByRole("button", { name: /Confirmar y entrar|Confirm and sign in/i }).click();
	await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
	expect(attempts()).toBe(2);
});

test("a recovery magic link exchanges its opaque challenge and sanitizes the URL", async ({ page }, testInfo) => {
	test.skip(testInfo.project.name.startsWith("dashboard"), "Consumer App recovery-link flow");
	const challenge = "r".repeat(43);
	const stepUpToken = "s".repeat(43);
	await mockFirebaseEmailLinkCompletion(page, {
		email: "qa@example.com",
		oobCode: "e2e-recovery",
		uid: "e2e-recovery-user",
	});
	await page.route("**/auth/step-up/email-link/exchange", async (route) => {
		expect(route.request().headers().authorization).toMatch(/^Bearer /u);
		expect(route.request().postDataJSON()).toEqual({ challenge });
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				stepUpToken,
				action: "start",
				expiresInSeconds: 600,
			}),
		});
	});

	await openLogin(page, testInfo);
	await page.evaluate(() => localStorage.setItem("gatopago:firebase-email-link:v1", JSON.stringify({
		email: "qa@example.com",
		purpose: "recovery",
		requestedAt: Date.now(),
	})));
	const continueUrl = encodeURIComponent(
		`https://app.parmelia.me/login?flow=recovery&challenge=${challenge}`,
	);
	await page.goto(`/login?mode=signIn&oobCode=e2e-recovery&apiKey=e2e-key&continueUrl=${continueUrl}`);
	await expect(page).toHaveURL(/\/recover$/, { timeout: 10_000 });
	const proof = await page.evaluate(() => sessionStorage.getItem("gatopago:recovery-email-link-proof:v1"));
	expect(JSON.parse(proof ?? "null")).toMatchObject({
		stepUpToken,
		action: "start",
	});
	expect(new URL(page.url()).search).toBe("");
});

test("dashboard exposes invalid email errors through an alert", async ({ page }, testInfo) => {
	test.skip(!testInfo.project.name.startsWith("dashboard"), "Dashboard-only validation surface");
	await openLogin(page, testInfo);
	await page.getByRole("button", { name: /correo/i }).click();
	await page.getByRole("textbox", { name: /correo/i }).fill("qa@example");
	await page.getByRole("button", { name: /enviarme un código/i }).click();

	const alert = page.getByRole("alert");
	await expect(alert).toContainText("Escribe un correo válido");
});

test("Turnstile times out visibly and recovers in place", async ({ page }, testInfo) => {
	await page.clock.install();
	await page.addInitScript(() => {
		(window as Window & { __turnstileTestMode?: string }).__turnstileTestMode = "hang";
	});
	await openLogin(page, testInfo);
	await page.getByRole("button", { name: /correo|email/i }).first().click();
	await expect(page.getByText(/Comprobando seguridad|Checking security/i)).toBeVisible();

	await page.clock.fastForward(15_100);
	const retry = page.getByRole("button", { name: /Intentar de nuevo|Try again/i });
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(retry).toBeVisible();

	await page.evaluate(() => {
		(window as Window & { __turnstileTestMode?: string }).__turnstileTestMode = "unsupported";
	});
	await retry.click();
	await expect(page.getByRole("alert")).toBeVisible();

	await page.evaluate(() => {
		(window as Window & { __turnstileTestMode?: string }).__turnstileTestMode = "verified";
	});
	await retry.click();
	await expect(page.getByRole("button", { name: /enlace|link|código|code/i })).toBeEnabled();
});
