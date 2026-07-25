import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	acquireCronLock,
	createAccountOperation,
	createCrosschainOp,
	finishAccountOperation,
	getActiveAccountOperation,
	getCrosschainOpById,
	releaseCronLock,
	renewCronLock,
	updateCrosschainOp,
	type PendingPaymentRecord,
} from "../src/services/storage";
import { settlePayment } from "../src/services/settlement";
import { hmacSha256Hex } from "../src/services/webhooks";
import { SignerLeaseBusyError, withSignerLease } from "../src/services/signerLease";

describe.sequential("Cloudflare Worker runtime", () => {
	it("does not load developer secrets", () => {
		expect(env.FCM_SERVICE_ACCOUNT).toBeUndefined();
		expect(env.FAUCET_PRIVATE_KEY).toBeUndefined();
		expect(env.PAYMASTER_SIGNER_PRIVATE_KEY).toBeUndefined();
		expect(env.RECOVERY_GUARDIAN_PRIVATE_KEY).toBeUndefined();
	});

	it("applies the complete D1 migration chain", async () => {
		const applied = await env.PARMELIA_DB.prepare(
			"SELECT name FROM d1_migrations ORDER BY id",
		).all<{ name: string }>();

		expect(applied.results.map((row) => row.name)).toEqual([
			"0001_schema.sql",
			"0002_api.sql",
			"0003_router.sql",
			"0004_push_tokens.sql",
			"0005_crosschain.sql",
			"0006_hardening.sql",
			"0007_payment_lifecycle.sql",
			"0008_earn.sql",
			"0009_profile.sql",
			"0010_integrity.sql",
			"0011_account_operations.sql",
		]);
	});

	it("preserves strict tables, foreign keys and integrity columns", async () => {
		const tables = await env.PARMELIA_DB.prepare("PRAGMA table_list").all<{
			name: string;
			strict: number;
		}>();
		const strictByName = new Map(tables.results.map((row) => [row.name, row.strict]));
		for (const table of [
			"users",
			"payment_links",
			"pending_payments",
			"ledger",
			"webhook_deliveries",
			"crosschain_operations",
			"crosschain_mint_attempts",
			"cron_leases",
			"account_operations",
		]) {
			expect(strictByName.get(table), `${table} must remain STRICT`).toBe(1);
		}

		const ledgerColumns = await env.PARMELIA_DB.prepare("PRAGMA table_info(ledger)").all<{
			name: string;
		}>();
		expect(ledgerColumns.results.map((row) => row.name)).toContain("amount_source");

		const linkColumns = await env.PARMELIA_DB.prepare("PRAGMA table_info(payment_links)").all<{
			name: string;
		}>();
		expect(linkColumns.results.map((row) => row.name)).toEqual(
			expect.arrayContaining(["payment_claim", "payment_claim_expires_at", "payment_claim_tx_hash"]),
		);

		await expect(
			env.PARMELIA_DB.prepare(
				"INSERT INTO passkeys (credential_id, uid, qx, qy) VALUES (?, ?, ?, ?)",
			)
				.bind("orphan", "missing-user", "1", "2")
				.run(),
		).rejects.toThrow();
	});

	it("enforces one unresolved account operation per user and kind", async () => {
		const createdAt = new Date().toISOString();
		const base = {
			uid: "runtime-operation-user",
			kind: "recovery_cancel" as const,
			txHash: `0x${"31".repeat(32)}` as `0x${string}`,
			rawTransaction: `0x${"41".repeat(64)}` as `0x${string}`,
			signerAddress: "0x00000000000000000000000000000000000000aa" as `0x${string}`,
			nonce: 1,
			metadata: { walletAddress: "0x00000000000000000000000000000000000000bb" },
			createdAt,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		expect(await createAccountOperation(env, { id: "runtime-operation-1", ...base })).toBe(true);
		expect(await createAccountOperation(env, {
			id: "runtime-operation-2",
			...base,
			txHash: `0x${"32".repeat(32)}`,
		})).toBe(false);

		expect(await finishAccountOperation(env, "runtime-operation-1", "needs_review", {
			errorCode: "TX_STUCK",
		})).toBe(true);
		expect((await getActiveAccountOperation(env, base.uid, base.kind))?.status).toBe("needs_review");
		await expect(withSignerLease(
			env,
			{ chainId: 421614, signerAddress: base.signerAddress },
			async () => undefined,
		)).rejects.toBeInstanceOf(SignerLeaseBusyError);
		const blockedHealth = await exports.default.fetch(new Request("https://worker.test/health"));
		expect(blockedHealth.status).toBe(503);
		expect(await blockedHealth.json()).toMatchObject({
			status: "not_ready",
			issues: expect.arrayContaining(["signer_nonce_blocked"]),
		});
		expect(await createAccountOperation(env, {
			id: "runtime-operation-3",
			...base,
			txHash: `0x${"33".repeat(32)}`,
		})).toBe(false);
		await env.PARMELIA_DB.prepare("DELETE FROM account_operations WHERE id = ?")
			.bind("runtime-operation-1")
			.run();
	});

	it("serves readiness and enforces authentication through workerd", async () => {
		const health = await exports.default.fetch(new Request("https://worker.test/health"));
		expect(health.status).toBe(200);
		expect(health.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
		expect(await health.json()).toMatchObject({ status: "ok", network: "arbitrum-sepolia", issues: [] });

		const protectedResponse = await exports.default.fetch(
			new Request("https://worker.test/user/profile", {
				headers: { "X-Request-Id": "runtime-request-123" },
			}),
		);
		expect(protectedResponse.status).toBe(401);
		expect(protectedResponse.headers.get("X-Request-Id")).toBe("runtime-request-123");
		expect(await protectedResponse.json()).toMatchObject({
			error_code: "UNAUTHENTICATED",
			requestId: "runtime-request-123",
		});
	});

	it("enforces CORS and Web Crypto behavior through workerd", async () => {
		const response = await exports.default.fetch(
			new Request("https://worker.test/", {
				headers: { Origin: "https://app.parmelia.me" },
			}),
		);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.parmelia.me");
		expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Request-Id");
		expect(await hmacSha256Hex("secret", "message")).toBe(
			"8b5f48702995c1598c573db1e21866a9b825d4a794d169d7060a03605796360b",
		);
	});

	it("enforces the request body limit before route processing", async () => {
		const response = await exports.default.fetch(
			new Request("https://worker.test/links", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ payload: "x".repeat(65 * 1024) }),
			}),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error_code: "PAYLOAD_TOO_LARGE" });
	});

	it("reads a migrated D1 payment link through the HTTP route", async () => {
		const now = new Date().toISOString();
		await env.PARMELIA_DB.batch([
			env.PARMELIA_DB.prepare(
				"INSERT INTO users (uid, username, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			).bind("runtime-user", "runtime_user", "0x0000000000000000000000000000000000000001", now, now),
			env.PARMELIA_DB.prepare(
				`INSERT INTO payment_links
				 (id, owner_uid, wallet_address, amount, currency, reference, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
			).bind(
				"runtime-link",
				"runtime-user",
				"0x0000000000000000000000000000000000000001",
				"12.50",
				"USDC",
				"Runtime integration",
				now,
			),
		]);

		const response = await exports.default.fetch(new Request("https://worker.test/links/runtime-link"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: "runtime-link",
			ownerUid: "runtime-user",
			amount: "12.50",
			status: "pending",
		});
	});

	it("repairs a CCTP hand-off stranded after broadcast", async () => {
		const now = new Date().toISOString();
		const opId = `0x${"42".repeat(32)}`;
		const txHash = `0x${"24".repeat(32)}`;
		await createCrosschainOp(env, {
			opId,
			uid: "runtime-user",
			direction: "outbound",
			provider: "cctp",
			cctpMode: "standard",
			sourceChainId: 421614,
			destinationChainId: 84532,
			sourceDomain: 3,
			destinationDomain: 6,
			destinationCaller: null,
			sourceTxHash: null,
			destinationTxHash: null,
			messageNonce: null,
			messageBytes: null,
			attestation: null,
			token: "USDC",
			amountIn: "12500000",
			parmeliaFee: "0",
			maxFee: "0",
			minFinalityThreshold: 1000,
			cctpFeeEstimated: null,
			amountOutExpected: "12500000",
			recipient: "0x0000000000000000000000000000000000000002",
			status: "quoted",
			statusDetail: null,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});

		const pending: PendingPaymentRecord = {
			userOpHash: `0x${"11".repeat(32)}`,
			uid: "runtime-user",
			linkId: null,
			wallet: "0x0000000000000000000000000000000000000002",
			senderAddress: "0x0000000000000000000000000000000000000001",
			amount: "12.5",
			currency: "CROSSCHAIN",
			userOp: {},
			meta: { opId, amountIn: "12500000", recipient: "0x0000000000000000000000000000000000000002" },
			status: "submitting",
			submittedTxHash: null,
			createdAt: now,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		};

		await settlePayment(env, pending, txHash);

		expect(await getCrosschainOpById(env, opId)).toMatchObject({
			status: "submitted",
			sourceTxHash: txHash,
		});
		const ledger = await env.PARMELIA_DB.prepare(
			"SELECT amount, amount_source FROM ledger WHERE uid = ? AND tx_hash = ?",
		)
			.bind("runtime-user", txHash)
			.first<{ amount: string; amount_source: string }>();
		expect(ledger).toEqual({ amount: "12.5", amount_source: "executed" });

		await updateCrosschainOp(env, opId, { status: "waiting_attestation" });
		await settlePayment(env, pending, txHash);
		expect(await getCrosschainOpById(env, opId)).toMatchObject({
			status: "waiting_attestation",
			sourceTxHash: txHash,
		});
	});

	it("keeps the cron lease exclusive and owner-bound", async () => {
		const firstOwner = await acquireCronLock(env, 60_000);
		expect(firstOwner).toBeTypeOf("string");
		expect(await acquireCronLock(env, 60_000)).toBeNull();
		expect(await renewCronLock(env, "not-the-owner", 120_000)).toBe(false);
		expect(await renewCronLock(env, firstOwner!, 120_000)).toBe(true);

		await releaseCronLock(env, "not-the-owner");
		expect(await acquireCronLock(env, 60_000)).toBeNull();

		await releaseCronLock(env, firstOwner!);
		const secondOwner = await acquireCronLock(env, 60_000);
		expect(secondOwner).toBeTypeOf("string");
		expect(secondOwner).not.toBe(firstOwner);
		await releaseCronLock(env, secondOwner!);
	});
});
