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
	await page.addInitScript(() => {
		Object.defineProperty(window, "ethereum", {
			configurable: true,
			value: {
				request: async ({ method }: { method: string }) => {
					if (method === "eth_requestAccounts" || method === "eth_accounts") {
						return ["0x00000000000000000000000000000000000000cc"];
					}
					if (method === "eth_chainId") return "0x66eee";
					throw new Error(`Unexpected wallet method: ${method}`);
				},
			},
		});
	});
	await page.route("**/checkout/a11y-link", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				link: {
					id: "a11y-link",
					intentId: "pi_a11y",
					amount: "12.5",
					currency: "USDC",
					reference: "Accessibility checkout",
					wallet: "0x00000000000000000000000000000000000000aa",
					status: "pending",
					txHash: null,
					paidAt: null,
					paidBy: null,
					createdAt: "2026-08-25T00:00:00.000Z",
				},
				intent: {
					id: "pi_a11y",
					amount: "12.5",
					amount_atomic: "12500000",
					amount_mode: "fixed",
					currency: "USDC",
					reference: "Accessibility checkout",
					status: "awaiting_payment",
					mode: "test",
					tx_hash: null,
					paid_at: null,
					paid_amount_atomic: "0",
					overpaid_amount_atomic: "0",
					settlement_chain_id: 421614,
					expires_at: null,
					created_at: "2026-08-25T00:00:00.000Z",
					updated_at: "2026-08-25T00:00:00.000Z",
				},
				networks: [{
					chain_id: 421614,
					name: "Arbitrum Sepolia",
					routes: ["local"],
					usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
					permit_mode: "eip2612",
				}],
			}),
		});
	});

	await page.goto("/pay?id=a11y-link", { waitUntil: "domcontentloaded" });
	await dismissDesktopNotice(page);
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
	await expect(page.getByText("12.50")).toBeVisible();
	await expectNoWcagViolations(page);

	await expect(page.getByRole("button", { name: /inicia|sign in/i })).toHaveCount(0);
	const connect = page.getByRole("button", { name: /wallet del navegador|browser wallet/i });
	await tabTo(page, connect);
	await connect.click();
	await expect(page.getByText("0x0000…00cc")).toBeVisible();
	await expect(page.getByRole("button", { name: /revisar pago|review payment/i })).toBeEnabled();
	const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
	expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
});

test("changing payment links hides the previous link before the next response", async ({ page }) => {
	const checkout = (id: string, amount: string) => ({
		link: {
			id, intentId: `pi_${id}`, amount, currency: "USDC", reference: `Checkout ${id}`,
			wallet: "0x00000000000000000000000000000000000000aa", status: "pending",
			txHash: null, paidAt: null, paidBy: null, createdAt: "2026-08-25T00:00:00.000Z",
		},
		intent: {
			id: `pi_${id}`, amount, amount_atomic: `${Number(amount) * 1_000_000}`,
			amount_mode: "fixed", currency: "USDC", reference: `Checkout ${id}`,
			status: "awaiting_payment", mode: "test", tx_hash: null, paid_at: null,
			paid_amount_atomic: "0", overpaid_amount_atomic: "0", settlement_chain_id: 421614,
			expires_at: null, created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z",
		},
		networks: [{
			chain_id: 421614, name: "Arbitrum Sepolia", routes: ["local"],
			usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", permit_mode: "eip2612",
		}],
	});

	let releaseSecond!: () => void;
	const secondResponse = new Promise<void>((resolve) => { releaseSecond = resolve; });
	await page.route("**/checkout/link-a", (route) => route.fulfill({
		contentType: "application/json", body: JSON.stringify(checkout("link-a", "11")),
	}));
	await page.route("**/checkout/link-b", async (route) => {
		await secondResponse;
		await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
	});

	await page.goto("/pay?id=link-a", { waitUntil: "domcontentloaded" });
	await dismissDesktopNotice(page);
	await expect(page.getByText("11.00")).toBeVisible();

	await page.evaluate(() => {
		window.history.pushState({}, "", "/pay?id=link-b");
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	await expect(page.locator('[aria-busy="true"]')).toBeVisible();
	await expect(page.getByText("11.00")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /revisar pago|review payment/i })).toHaveCount(0);

	releaseSecond();
	await expect(page.locator('[aria-busy="true"]')).toBeHidden();
	await expect(page.getByText(/link de cobro no existe|payment link doesn't exist/i)).toBeVisible();
	await expect(page.getByText("11.00")).toHaveCount(0);
});

test("external wallet checkout recovers transaction registration after reload", async ({ page }) => {
	const payer = "0x00000000000000000000000000000000000000cc";
	const sourceHash = `0x${"ab".repeat(32)}`;
	const approvalHash = `0x${"cd".repeat(32)}`;
	let registerCalls = 0;
	let registrationAllowed = false;
	let registrationRecovered = false;
	await page.addInitScript(({ connectedPayer, paymentHash, approveHash }) => {
		const calls: string[] = [];
		let sentTransactions = 0;
		Object.defineProperty(window, "__checkoutWalletCalls", { configurable: true, value: calls });
		Object.defineProperty(window, "ethereum", {
			configurable: true,
			value: {
				request: async ({ method, params }: { method: string; params?: unknown[] }) => {
					calls.push(method);
					if (method === "eth_requestAccounts" || method === "eth_accounts") return [connectedPayer];
					if (method === "eth_chainId") return "0x66eee";
					if (method === "eth_call") {
						const call = params?.[0] as { data?: string } | undefined;
						if (call?.data?.startsWith("0xdd62ed3e")) return `0x${"0".repeat(64)}`;
						return `0x${(100_000_000n).toString(16).padStart(64, "0")}`;
					}
					if (method === "eth_signTypedData_v4") {
						const unsupported = new Error("Method not supported") as Error & { code: number };
						unsupported.code = -32601;
						throw unsupported;
					}
					if (method === "personal_sign") return `0x${"66".repeat(65)}`;
					if (method === "eth_estimateGas") return "0x186a0";
					if (method === "eth_sendTransaction") {
						sentTransactions += 1;
						return sentTransactions === 1 ? approveHash : paymentHash;
					}
					if (method === "eth_getTransactionReceipt") return { status: "0x1" };
					throw new Error(`Unexpected wallet method: ${method}`);
				},
			},
		});
	}, { connectedPayer: payer, paymentHash: sourceHash, approveHash: approvalHash });

	const checkout = {
		link: {
			id: "flow-link", intentId: "pi_flow", amount: "12.5", currency: "USDC",
			reference: "External wallet flow", wallet: "0x00000000000000000000000000000000000000aa",
			status: "pending", txHash: null, paidAt: null, paidBy: null, createdAt: "2026-08-25T00:00:00.000Z",
		},
		intent: {
			id: "pi_flow", amount: "12.5", amount_atomic: "12500000", amount_mode: "fixed", currency: "USDC",
			reference: "External wallet flow", status: "awaiting_payment", mode: "test", tx_hash: null, paid_at: null,
			paid_amount_atomic: "0", overpaid_amount_atomic: "0", settlement_chain_id: 421614, expires_at: null,
			created_at: "2026-08-25T00:00:00.000Z", updated_at: "2026-08-25T00:00:00.000Z",
		},
		networks: [{
			chain_id: 421614, name: "Arbitrum Sepolia", routes: ["local"],
			usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", permit_mode: "eip2612",
		}],
	};
	const quote = {
		id: "qt_flow", intent_id: "pi_flow", payer, source_chain_id: 421614, route: "local",
		settlement_amount_atomic: "12500000", platform_fee_atomic: "0", cctp_fee_atomic: "0",
		gross_payer_amount_atomic: "12500000", fee_source: "local", platform_fee_bps: 0,
		platform_fee_bearer: "none", platform_fee_recipient: null, route_fee_cap_bps: 100,
		fee_observed_at: "2026-08-25T00:00:00.000Z", expires_at: "2030-08-25T00:00:00.000Z",
		quote_hash: `0x${"44".repeat(32)}`,
		payer_proof_message: "GatoPago checkout test proof",
	};
	const baseAttempt = {
		id: "pa_flow", intent_id: "pi_flow", payer, source_chain_id: 421614, route: "local", status: "reserved",
		router: "0x1111111111111111111111111111111111111111",
		authorization: {
			intentId: `0x${"11".repeat(32)}`, attemptId: `0x${"22".repeat(32)}`, payer,
			merchant: "0x00000000000000000000000000000000000000aa", settlementAmount: "12500000",
			platformFee: "0", validAfter: 1, validUntil: 1_999_999_999, metadataHash: `0x${"00".repeat(32)}`,
		},
		signature: `0x${"33".repeat(65)}`, authorization_hash: `0x${"55".repeat(32)}`,
		valid_after: 1, valid_until: 1_999_999_999, source_tx_hash: null, destination_tx_hash: null,
		user_op_hash: null, settled_amount_atomic: "0",
		fee_snapshot: {
			policy_id: "free-default", policy_version: 1, rule_id: "free-default", platform_fee_bps: 0,
			platform_fee_atomic: "0", network_fee_max_atomic: "0", gross_payer_amount_atomic: "12500000",
			bearer: "none", recipient: null, route_fee_cap_bps: 100,
		},
	};

	await page.route("**/checkout/flow-link", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(checkout) }));
	await page.route("**/checkout/flow-link/quotes", (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(quote) }));
	await page.route("**/checkout/flow-link/attempts", (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(baseAttempt) }));
	await page.route("**/checkout/flow-link/attempts/pa_flow/register", (route) => {
		registerCalls += 1;
		if (!registrationAllowed) return route.abort("connectionfailed");
		registrationRecovered = true;
		return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...baseAttempt, status: "submitted", source_tx_hash: sourceHash }) });
	});
	await page.route("**/checkout/flow-link/attempts/pa_flow", (route) => route.fulfill({
		contentType: "application/json",
		body: JSON.stringify(registrationRecovered
			? { ...baseAttempt, status: "paid", source_tx_hash: sourceHash, settled_amount_atomic: "12500000", intent_status: "paid" }
			: baseAttempt),
	}));

	await page.goto("/pay?id=flow-link", { waitUntil: "domcontentloaded" });
	await dismissDesktopNotice(page);
	await page.getByRole("button", { name: /wallet del navegador|browser wallet/i }).click();
	await page.getByRole("button", { name: /revisar pago|review payment/i }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.getByRole("button", { name: /confirmar en mi wallet|confirm in my wallet/i }).click();
	await expect.poll(() => page.evaluate(() => {
		const raw = sessionStorage.getItem("gatopago.checkout.v2:flow-link");
		return raw ? JSON.parse(raw).sourceTxHash : null;
	})).toBe(sourceHash);
	const walletCalls = await page.evaluate(() => (window as unknown as { __checkoutWalletCalls: string[] }).__checkoutWalletCalls);
	expect(walletCalls).toContain("eth_signTypedData_v4");
	expect(walletCalls).toContain("personal_sign");
	expect(walletCalls.filter((method) => method === "eth_sendTransaction")).toHaveLength(2);
	registrationAllowed = true;
	await page.reload({ waitUntil: "domcontentloaded" });
	await dismissDesktopNotice(page);

	await expect(page.getByText(/este cobro ya fue pagado|request was already paid/i)).toBeVisible();
	expect(registerCalls).toBe(2);
	expect(await page.evaluate(() => sessionStorage.getItem("gatopago.checkout.v2:flow-link"))).toBeNull();
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
