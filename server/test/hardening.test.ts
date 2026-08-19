import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { getCctpChainByChainId, NETWORKS } from "../../shared";
import { validateCctpMessage } from "../src/services/crosschainRelayer";
import {
	getFaucetKey,
	getPaymasterSignerKey,
	getRecoveryGuardianKey,
	getRouterSignerKey,
	KeyConfigError,
} from "../src/services/keys";
import { verifyTurnstile } from "../src/services/turnstile";
import { isIntentPayable, type CrosschainOpRecord } from "../src/services/storage";
import type { Bindings } from "../src/middlewares/auth";
import { getFaucetPolicy } from "../src/services/accountOperations";
import { validateWebhookUrl } from "../src/routes/merchant.routes";
import { routerAuthorizationDeadline, RouterError } from "../src/services/paymentRouter";
import { validateRuntimeConfig } from "../src/services/runtimeConfig";
import { internalTransferSenderAddresses } from "../src/services/indexer";
import { getRpcEndpointCapabilities } from "../src/services/rpcProviders";
import worker from "../src/index";
import {
	activeWebhookSecretPrefix,
	decryptWebhookSecret,
	encryptWebhookSecret,
	isEncryptedWebhookSecret,
	rotateWebhookSecret,
} from "../src/services/webhookSecrets";

// ---------- helpers ----------

function envFor(chainKey: string, extra: Partial<Bindings> = {}): Bindings {
	const emptyRow = {
		payment_reconcile_dead: 0,
		payment_reconcile_active: 0,
		user_event_dead: 0,
		user_event_active: 0,
		balance_refresh_failed: 0,
	};
	const emptyDb = {
		prepare: () => {
			const statement = {
				first: async () => emptyRow,
				all: async () => ({ results: [] }),
				bind: () => statement,
			};
			return statement;
		},
	} as unknown as D1Database;
	return {
		RPC_URL: "http://localhost:1",
		PRIVATE_KEY: "0x" + "11".repeat(32),
		FIREBASE_PROJECT_ID: "test",
		GATOPAGO_DB: emptyDb,
		CHAIN_KEY: chainKey as Bindings["CHAIN_KEY"],
		...extra,
	};
}

/** Build a synthetic CCTP v2 message: header (148 bytes) + BurnMessageV2 body. */
function buildCctpMessage(params: {
	sourceDomain: number;
	destinationDomain: number;
	mintRecipient: string; // 0x + 40 hex
	amount: bigint;
	direction?: "inbound" | "outbound";
	version?: number;
	maxFee?: bigint;
	feeExecuted?: bigint;
	minFinality?: number;
	finalityExecuted?: number;
	headerSender?: string;
	burnToken?: string;
	bodyVersion?: number;
	messageSender?: string;
	expirationBlock?: bigint;
	hookData?: string;
}): Hex {
	const u32 = (n: number) => n.toString(16).padStart(8, "0");
	const b32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
	const u256 = (n: bigint) => n.toString(16).padStart(64, "0");
	const source = getCctpChainByChainId(params.sourceDomain === 3 ? 421614 : 11155111)!;
	const destination = getCctpChainByChainId(params.destinationDomain === 6 ? 84532 : 11155111)!;
	const router = NETWORKS["arbitrum-sepolia"].contracts.crosschainRouter;
	const header =
		u32(params.version ?? 1) +
		u32(params.sourceDomain) +
		u32(params.destinationDomain) +
		b32("aa") + // nonce
		b32(params.headerSender ?? source.tokenMessenger) +
		b32(destination.tokenMessenger) +
		b32("00") + // destinationCaller
		u32(params.minFinality ?? 1000) +
		u32(params.finalityExecuted ?? 1000);
	const body =
		u32(params.bodyVersion ?? 1) +
		b32(params.burnToken ?? source.usdc) +
		b32(params.mintRecipient) +
		u256(params.amount) +
		b32(params.messageSender ?? (params.direction === "inbound" ? "ee" : router)) +
		u256(params.maxFee ?? 0n) +
		u256(params.feeExecuted ?? 0n) +
		u256(params.expirationBlock ?? 1n);
	return `0x${header}${body}${params.hookData ?? ""}` as Hex;
}

const RECIPIENT = "0x000000000000000000000000000000000000bEEF";

function opFor(partial: Partial<CrosschainOpRecord> = {}): CrosschainOpRecord {
	return {
		opId: "op1",
		uid: "u1",
		direction: "outbound",
		provider: "cctp",
		cctpMode: "fast",
		sourceChainId: 421614,
		destinationChainId: 84532,
		sourceDomain: 3,
		destinationDomain: 6,
		destinationCaller: null,
		sourceTxHash: "0x" + "ab".repeat(32),
		destinationTxHash: null,
		messageNonce: null,
		messageBytes: null,
		attestation: null,
		token: "USDC",
		amountIn: "1000000",
		gatoPagoFee: "1000",
		maxFee: null,
		minFinalityThreshold: 1000,
		cctpFeeEstimated: null,
		amountOutExpected: null,
		recipient: RECIPIENT,
		status: "submitted",
		statusDetail: null,
		attemptCount: 0,
		lastError: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		completedAt: null,
		...partial,
	};
}

// ---------- CCTP message validation ----------

describe("validateCctpMessage", () => {
	// outbound burns net-of-fee: 1000000 - 1000
	const NET = 999000n;

	it("accepts a message that matches the op exactly", () => {
		const msg = buildCctpMessage({ sourceDomain: 3, destinationDomain: 6, mintRecipient: RECIPIENT, amount: NET });
		expect(validateCctpMessage(opFor(), msg)).toBeNull();
	});

	it("rejects a wrong source domain", () => {
		const msg = buildCctpMessage({ sourceDomain: 0, destinationDomain: 6, mintRecipient: RECIPIENT, amount: NET });
		expect(validateCctpMessage(opFor(), msg)).toMatch(/sourceDomain/);
	});

	it("rejects a wrong destination domain", () => {
		const msg = buildCctpMessage({ sourceDomain: 3, destinationDomain: 0, mintRecipient: RECIPIENT, amount: NET });
		expect(validateCctpMessage(opFor(), msg)).toMatch(/destinationDomain/);
	});

	it("rejects a burn destined to someone else (third-party tx registered on our op)", () => {
		const msg = buildCctpMessage({
			sourceDomain: 3,
			destinationDomain: 6,
			mintRecipient: "0x000000000000000000000000000000000000dEaD",
			amount: NET,
		});
		expect(validateCctpMessage(opFor(), msg)).toMatch(/mintRecipient/);
	});

	it("rejects a wrong amount", () => {
		const msg = buildCctpMessage({ sourceDomain: 3, destinationDomain: 6, mintRecipient: RECIPIENT, amount: 5n });
		expect(validateCctpMessage(opFor(), msg)).toMatch(/amount/);
	});

	it("rejects wrong protocol/body versions and contract addresses", () => {
		const base = { sourceDomain: 3, destinationDomain: 6, mintRecipient: RECIPIENT, amount: NET };
		expect(validateCctpMessage(opFor(), buildCctpMessage({ ...base, version: 2 }))).toMatch(/version/);
		expect(validateCctpMessage(opFor(), buildCctpMessage({ ...base, bodyVersion: 2 }))).toMatch(/burn message version/);
		expect(validateCctpMessage(opFor(), buildCctpMessage({ ...base, headerSender: "0x" + "12".repeat(20) }))).toMatch(/TokenMessenger/);
		expect(validateCctpMessage(opFor(), buildCctpMessage({ ...base, burnToken: "0x" + "34".repeat(20) }))).toMatch(/burnToken/);
	});

	it("rejects fee/finality mismatches and non-empty hooks", () => {
		const base = { sourceDomain: 3, destinationDomain: 6, mintRecipient: RECIPIENT, amount: NET };
		expect(validateCctpMessage(opFor({ maxFee: "5" }), buildCctpMessage({ ...base, maxFee: 6n }))).toMatch(/maxFee/);
		expect(validateCctpMessage(opFor({ maxFee: "5" }), buildCctpMessage({ ...base, maxFee: 5n, feeExecuted: 6n }))).toMatch(/feeExecuted/);
		expect(validateCctpMessage(opFor(), buildCctpMessage({ ...base, minFinality: 2000 }))).toMatch(/minFinality/);
		expect(validateCctpMessage(opFor(), buildCctpMessage({ ...base, hookData: "00" }))).toMatch(/hookData/);
	});

	it("inbound expects the FULL amountIn (no GatoPago fee skim)", () => {
		const op = opFor({ direction: "inbound", gatoPagoFee: "0" });
		const msg = buildCctpMessage({
			sourceDomain: 3,
			destinationDomain: 6,
			mintRecipient: RECIPIENT,
			amount: 1000000n,
			direction: "inbound",
		});
		expect(validateCctpMessage(op, msg)).toBeNull();
	});

	it("rejects a truncated message", () => {
		expect(validateCctpMessage(opFor(), "0x1234" as Hex)).toMatch(/short/);
	});
});

// ---------- key policy (least privilege) ----------

describe("signing key policy", () => {
	it("uses a dedicated faucet key and permits fallback only on testnet", () => {
		const dedicated = "0x" + "44".repeat(32);
		expect(getFaucetKey(envFor("arbitrum-sepolia"))).toBe("0x" + "11".repeat(32));
		expect(getFaucetKey(envFor("arbitrum-one", { FAUCET_PRIVATE_KEY: dedicated }))).toBe(dedicated);
		expect(() => getFaucetKey(envFor("arbitrum-one"))).toThrow(KeyConfigError);
		expect(() => getFaucetKey(envFor("arbitrum-one", {
			FAUCET_PRIVATE_KEY: "0x" + "11".repeat(32),
		}))).toThrow(KeyConfigError);
	});

	it("uses the dedicated paymaster key when present", () => {
		const env = envFor("arbitrum-one", { PAYMASTER_SIGNER_PRIVATE_KEY: "0x" + "22".repeat(32) });
		expect(getPaymasterSignerKey(env)).toBe("0x" + "22".repeat(32));
	});

	it("falls back to PRIVATE_KEY on testnet only", () => {
		expect(getPaymasterSignerKey(envFor("arbitrum-sepolia"))).toBe("0x" + "11".repeat(32));
	});

	it("fails closed on mainnet without a dedicated paymaster key", () => {
		expect(() => getPaymasterSignerKey(envFor("arbitrum-one"))).toThrow(KeyConfigError);
	});

	it("fails closed on mainnet without a dedicated router key", () => {
		expect(() => getRouterSignerKey(envFor("arbitrum-one", { PAYMASTER_SIGNER_PRIVATE_KEY: "0x" + "22".repeat(32) }))).toThrow(
			KeyConfigError,
		);
	});

	it("router key falls back to the paymaster signer on testnet", () => {
		const env = envFor("arbitrum-sepolia", { PAYMASTER_SIGNER_PRIVATE_KEY: "0x" + "22".repeat(32) });
		expect(getRouterSignerKey(env)).toBe("0x" + "22".repeat(32));
	});

	it("requires a separate recovery guardian on mainnet", () => {
		expect(() => getRecoveryGuardianKey(envFor("arbitrum-one"))).toThrow(KeyConfigError);
		expect(() => getRecoveryGuardianKey(envFor("arbitrum-one", {
			RECOVERY_GUARDIAN_PRIVATE_KEY: "0x" + "11".repeat(32),
		}))).toThrow(KeyConfigError);
		expect(getRecoveryGuardianKey(envFor("arbitrum-one", {
			RECOVERY_GUARDIAN_PRIVATE_KEY: "0x" + "33".repeat(32),
		}))).toBe("0x" + "33".repeat(32));
	});
});

describe("faucet policy", () => {
	it("is convenient on testnet but fail-closed on mainnet", () => {
		expect(getFaucetPolicy(envFor("arbitrum-sepolia")).enabled).toBe(true);
		expect(getFaucetPolicy(envFor("arbitrum-sepolia", { FAUCET_ENABLED: "false" })).enabled).toBe(false);
		expect(getFaucetPolicy(envFor("arbitrum-one", { FAUCET_ENABLED: "true" })).enabled).toBe(false);
		expect(getFaucetPolicy(envFor("arbitrum-one", {
			FAUCET_ENABLED: "true",
			FAUCET_DAILY_BUDGET_USDC: "25",
		}))).toEqual({ enabled: true, dailyClaims: 5 });
	});

	it("keeps relayer and faucet transfers out of external-deposit indexing", () => {
		expect(internalTransferSenderAddresses(envFor("arbitrum-sepolia"))).toEqual(new Set([
			"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
		]));
		expect(internalTransferSenderAddresses(envFor("arbitrum-one", {
			FAUCET_PRIVATE_KEY: "0x" + "44".repeat(32),
		}))).toEqual(new Set([
			"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
			"0x7564105e977516c53be337314c7e53838967bdac",
		]));
	});
});

describe("router authorization deadline", () => {
	it("never extends beyond the intent expiry", () => {
		const now = 1_000_000;
		expect(routerAuthorizationDeadline({ expiresAt: new Date((now + 120) * 1000).toISOString() }, now)).toBe(now + 120);
		expect(routerAuthorizationDeadline({ expiresAt: null }, now)).toBe(now + 3600);
		expect(() => routerAuthorizationDeadline({ expiresAt: new Date((now - 1) * 1000).toISOString() }, now)).toThrow(RouterError);
	});
});

describe("webhook hardening", () => {
	it("rejects credentials, private hosts and unsafe live URLs", () => {
		expect(validateWebhookUrl("https://user:pass@example.com/hook", "live", false)).toBeNull();
		expect(validateWebhookUrl("https://127.0.0.1/hook", "live", false)).toBeNull();
		expect(validateWebhookUrl("http://localhost:3000/hook", "live", true)).toBeNull();
		expect(validateWebhookUrl("http://localhost:3000/hook", "test", true)).toBe("http://localhost:3000/hook");
		expect(validateWebhookUrl("https://hooks.example.com/pay", "live", false)).toBe("https://hooks.example.com/pay");
	});

	it("round-trips AES-GCM secrets", async () => {
		const env = envFor("arbitrum-one", {
			WEBHOOK_SECRET_ENCRYPTION_KEY: "44".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "2026_07",
		});
		const encrypted = await encryptWebhookSecret(env, "whsec_example");
		expect(encrypted.startsWith("enc:v2:2026_07:")).toBe(true);
		expect(isEncryptedWebhookSecret(encrypted)).toBe(true);
		expect(activeWebhookSecretPrefix(env)).toBe("enc:v2:2026_07:");
		expect(await decryptWebhookSecret(env, encrypted)).toBe("whsec_example");
	});

	it("rotates old ciphertext while keeping the previous key available", async () => {
		const oldEnv = envFor("arbitrum-one", {
			WEBHOOK_SECRET_ENCRYPTION_KEY: "44".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "2026_01",
		});
		const oldCiphertext = await encryptWebhookSecret(oldEnv, "whsec_rotate_me");
		const rotatedEnv = envFor("arbitrum-one", {
			WEBHOOK_SECRET_ENCRYPTION_KEY: "55".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "2026_07",
			WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS: JSON.stringify({ "2026_01": "44".repeat(32) }),
		});

		expect(await decryptWebhookSecret(rotatedEnv, oldCiphertext)).toBe("whsec_rotate_me");
		const rotated = await rotateWebhookSecret(rotatedEnv, oldCiphertext);
		expect(rotated.startsWith("enc:v2:2026_07:")).toBe(true);
		expect(await decryptWebhookSecret(rotatedEnv, rotated)).toBe("whsec_rotate_me");
		expect(await rotateWebhookSecret(rotatedEnv, rotated)).toBe(rotated);
	});

	it("rejects missing, malformed and unknown encryption keys", async () => {
		const sourceEnv = envFor("arbitrum-one", {
			WEBHOOK_SECRET_ENCRYPTION_KEY: "44".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "old",
		});
		const encrypted = await encryptWebhookSecret(sourceEnv, "whsec_example");
		await expect(decryptWebhookSecret(envFor("arbitrum-one", {
			WEBHOOK_SECRET_ENCRYPTION_KEY: "55".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "new",
		}), encrypted)).rejects.toThrow("is not configured");
		await expect(decryptWebhookSecret(envFor("arbitrum-one", {
			WEBHOOK_SECRET_ENCRYPTION_KEY: "55".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS: "not-json",
		}), encrypted)).rejects.toThrow("must be a JSON object");
		await expect(decryptWebhookSecret(sourceEnv, "enc:v2:old:broken")).rejects.toThrow("Malformed");
	});
});

describe("runtime configuration", () => {
	it("accepts a minimal valid testnet configuration", () => {
		expect(validateRuntimeConfig(envFor("arbitrum-sepolia"))).toEqual([]);
	});

	it("fails closed for incomplete mainnet configuration", () => {
		const codes = validateRuntimeConfig(envFor("arbitrum-one")).map((entry) => entry.code);
		expect(codes).toContain("WEBHOOK_KEY_MISSING");
		expect(codes).toContain("CORS_ALLOWLIST_INVALID");
		expect(codes).toContain("TURNSTILE_MISSING");
		expect(codes).toContain("CONTRACT_NOT_DEPLOYED");
		expect(codes).toContain("DEDICATED_KEY_INVALID");
	});

	it("requires distinct signing accounts on mainnet", () => {
		const sharedKey = "0x" + "11".repeat(32);
		const issues = validateRuntimeConfig(envFor("arbitrum-one", {
			PRIVATE_KEY: sharedKey,
			PAYMASTER_SIGNER_PRIVATE_KEY: sharedKey,
			PAYMENT_ROUTER_SIGNER_PRIVATE_KEY: "0x" + "22".repeat(32),
			RECOVERY_GUARDIAN_PRIVATE_KEY: "0x" + "33".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY: "44".repeat(32),
			ALLOWED_ORIGINS: "https://app.parmelia.me",
			APP_URL: "https://app.parmelia.me",
			TURNSTILE_SECRET_KEY: "configured",
		}));
		expect(issues.map((entry) => entry.code)).toContain("SIGNING_KEYS_NOT_DISTINCT");
	});

	it("requires a distinct faucet account only when mainnet faucet is enabled", () => {
		const validMainnetRoles = {
			PAYMASTER_SIGNER_PRIVATE_KEY: "0x" + "22".repeat(32),
			PAYMENT_ROUTER_SIGNER_PRIVATE_KEY: "0x" + "33".repeat(32),
			RECOVERY_GUARDIAN_PRIVATE_KEY: "0x" + "44".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY: "55".repeat(32),
			WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "active",
			ALLOWED_ORIGINS: "https://app.parmelia.me",
			APP_URL: "https://app.parmelia.me",
			TURNSTILE_SECRET_KEY: "configured",
			FAUCET_ENABLED: "true",
			FAUCET_DAILY_BUDGET_USDC: "25",
		} satisfies Partial<Bindings>;
		const missing = validateRuntimeConfig(envFor("arbitrum-one", validMainnetRoles));
		expect(missing).toContainEqual(expect.objectContaining({
			code: "DEDICATED_KEY_INVALID",
			message: expect.stringContaining("FAUCET_PRIVATE_KEY"),
		}));

		const colliding = validateRuntimeConfig(envFor("arbitrum-one", {
			...validMainnetRoles,
			FAUCET_PRIVATE_KEY: "0x" + "11".repeat(32),
		}));
		expect(colliding).toContainEqual(expect.objectContaining({
			code: "SIGNING_KEYS_NOT_DISTINCT",
			message: expect.stringContaining("FAUCET_PRIVATE_KEY"),
		}));

		const separated = validateRuntimeConfig(envFor("arbitrum-one", {
			...validMainnetRoles,
			FAUCET_PRIVATE_KEY: "0x" + "66".repeat(32),
		}));
		expect(separated.filter((entry) => entry.message.includes("FAUCET_PRIVATE_KEY"))).toEqual([]);
	});

	it("rejects unsupported chains and malformed optional RPC maps", () => {
		expect(validateRuntimeConfig(envFor("unknown"))[0]?.code).toBe("CHAIN_KEY_INVALID");
		expect(validateRuntimeConfig(envFor("arbitrum-sepolia", {
			CCTP_RPC_URLS: '{"84532":"ftp://invalid"}',
		})).map((entry) => entry.code)).toContain("CCTP_RPC_URLS_INVALID");
		expect(validateRuntimeConfig(envFor("arbitrum-sepolia", {
			INDEXER_SAFETY_SWEEP_SECONDS: "10",
		})).map((entry) => entry.code)).toContain(
			"INDEXER_SAFETY_SWEEP_INVALID",
		);
	});

	it("supports heterogeneous indexer plans through explicit capabilities", () => {
		const alchemy = "https://arb-sepolia.g.alchemy.com/v2/redacted";
		const publicRpc = "https://sepolia-rollup.arbitrum.io/rpc";
		const mixedEnv = envFor("arbitrum-sepolia", {
			RPC_INDEXER_URLS: `${alchemy},${publicRpc}`,
			RPC_PROVIDER_CAPABILITIES: JSON.stringify({
				indexer: [
					{
						id: "alchemy",
						priority: 0,
						maxConcurrency: 4,
						maxLogRange: 10,
					},
					{
						id: "arbitrum-public",
						priority: 1,
						maxConcurrency: 2,
						maxLogRange: 2_000,
					},
				],
			}),
		});
		expect(validateRuntimeConfig(mixedEnv)).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "RPC_PROVIDER_CAPABILITIES_COUNT_MISMATCH",
				}),
			]),
		);
		expect(getRpcEndpointCapabilities(mixedEnv, "indexer", 2)).toMatchObject(
			[
				{ id: "alchemy", maxLogRange: 10 },
				{ id: "arbitrum-public", maxLogRange: 2_000 },
			],
		);
	});

	it("requires an explicit reconciliation role without assuming a vendor plan", () => {
		const issues = validateRuntimeConfig(envFor("arbitrum-sepolia", {
			ALCHEMY_WEBHOOK_ENABLED: "true",
			ALCHEMY_WEBHOOK_ID: "wh_123",
			ALCHEMY_WEBHOOK_NETWORK: "ARB_SEPOLIA",
			ALCHEMY_WEBHOOK_SIGNING_KEY: "signing-key",
			ALCHEMY_NOTIFY_AUTH_TOKEN: "notify-auth-token",
			RPC_INDEXER_URLS: "https://arb-sepolia.g.alchemy.com/v2/redacted",
		}));
		expect(issues.map((entry) => entry.code)).not.toContain(
			"RPC_INDEXER_URLS_MISSING",
		);
	});

	it("validates the Custom Webhook that replaces permanent security polling", () => {
		const missing = validateRuntimeConfig(envFor("arbitrum-sepolia", {
			ALCHEMY_CUSTOM_WEBHOOK_ENABLED: "true",
			RPC_INDEXER_URLS: "https://sepolia-rollup.arbitrum.io/rpc",
		}));
		expect(missing.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"ALCHEMY_CUSTOM_WEBHOOK_ID_MISSING",
				"ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY_MISSING",
			]),
		);

		const configured = validateRuntimeConfig(envFor("arbitrum-sepolia", {
			ALCHEMY_CUSTOM_WEBHOOK_ENABLED: "true",
			ALCHEMY_CUSTOM_WEBHOOK_ID: "wh_custom",
			ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY: "signing-key",
			RPC_INDEXER_URLS: "https://arb-sepolia.g.alchemy.com/v2/redacted",
		}));
		expect(configured.map((entry) => entry.code)).not.toContain(
			"RPC_INDEXER_URLS_MISSING",
		);
	});

	it("exposes readiness and blocks invalid mainnet traffic", async () => {
		const context = {} as ExecutionContext;
		const testnetHealth = await worker.fetch(
			new Request("https://worker.example/health"),
			envFor("arbitrum-sepolia"),
			context,
		);
		expect(testnetHealth.status).toBe(200);
		expect(await testnetHealth.json()).toMatchObject({ status: "ok", issues: [] });

		const mainnetEnv = envFor("arbitrum-one");
		const mainnetHealth = await worker.fetch(new Request("https://worker.example/health"), mainnetEnv, context);
		expect(mainnetHealth.status).toBe(503);
		const blocked = await worker.fetch(new Request("https://worker.example/"), mainnetEnv, context);
		expect(blocked.status).toBe(503);
		expect(await blocked.json()).toMatchObject({ error_code: "SERVICE_UNAVAILABLE" });
	});

	it("allows CORS preflight with If-None-Match header", async () => {
		const context = {} as ExecutionContext;
		const req = new Request("https://worker.example/home", {
			method: "OPTIONS",
			headers: {
				Origin: "https://app.parmelia.me",
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "if-none-match, authorization, content-type",
			},
		});
		const res = await worker.fetch(req, envFor("arbitrum-sepolia", { ALLOWED_ORIGINS: "https://app.parmelia.me" }), context);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.parmelia.me");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("If-None-Match");
	});
});

// ---------- Turnstile fail-closed on mainnet ----------

describe("verifyTurnstile without a configured secret", () => {
	it("skips (allows) on testnet", async () => {
		await expect(verifyTurnstile(envFor("arbitrum-sepolia"), "tok")).resolves.toBe(true);
	});

	it("fails closed on mainnet", async () => {
		await expect(verifyTurnstile(envFor("arbitrum-one"), "tok")).resolves.toBe(false);
	});
});

// ---------- intent payability (status + expiry) ----------

describe("isIntentPayable", () => {
	const future = new Date(Date.now() + 60_000).toISOString();
	const past = new Date(Date.now() - 60_000).toISOString();

	it("payable while awaiting and unexpired", () => {
		expect(isIntentPayable({ status: "awaiting_payment", expiresAt: future })).toBe(true);
		expect(isIntentPayable({ status: "awaiting_payment", expiresAt: null })).toBe(true);
	});

	it("not payable when canceled, paid or expired", () => {
		expect(isIntentPayable({ status: "canceled", expiresAt: future })).toBe(false);
		expect(isIntentPayable({ status: "paid", expiresAt: future })).toBe(false);
		expect(isIntentPayable({ status: "awaiting_payment", expiresAt: past })).toBe(false);
	});
});
