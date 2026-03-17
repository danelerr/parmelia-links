import { Hono } from "hono";
import { AppContext } from "../middlewares/auth";
import {
	createPendingPayment,
	recordSentTransaction,
	saveUser,
	upsertPaymentLink,
	type PaymentLinkRecord,
} from "../services/storage";

const internalRoutes = new Hono<AppContext>();

type UserAccumulator = {
	uid: string;
	walletAddress?: string | null;
	username?: string | null;
	credentialId?: string | null;
	fundedAt?: string | null;
};

async function listAllKeys(env: AppContext["Bindings"], prefix: string) {
	const kv = env.PARMELIA_KV;
	if (!kv) return [] as string[];

	const keys: string[] = [];
	let cursor: string | undefined;
	let listComplete = false;

	while (!listComplete) {
		const page = await kv.list({ prefix, cursor, limit: 1000 });
		keys.push(...page.keys.map((key) => key.name));
		listComplete = page.list_complete;
		cursor = page.cursor || undefined;
	}

	return keys;
}

internalRoutes.post("/migrate-kv-to-d1", async (c) => {
	const migrationToken = c.env.STORAGE_MIGRATION_TOKEN;
	if (!migrationToken) {
		return c.json({ error: "Storage migration is not enabled." }, 404);
	}

	const providedToken = c.req.header("x-storage-migration-token");
	if (providedToken !== migrationToken) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const kv = c.env.PARMELIA_KV;
	if (!kv) {
		return c.json({ error: "PARMELIA_KV binding is not configured." }, 400);
	}

	const body = await c.req.json().catch(() => ({} as { purgeKv?: boolean; dryRun?: boolean }));
	const purgeKv = body?.purgeKv === true;
	const dryRun = body?.dryRun === true;

	const [
		userKeys,
		credentialKeys,
		fundedKeys,
		usernameKeys,
		linkKeys,
		pendingKeys,
		sentKeys,
		userLinksKeys,
	] = await Promise.all([
		listAllKeys(c.env, "user:"),
		listAllKeys(c.env, "credential:"),
		listAllKeys(c.env, "funded:"),
		listAllKeys(c.env, "username:"),
		listAllKeys(c.env, "link:"),
		listAllKeys(c.env, "pending:"),
		listAllKeys(c.env, "sent:"),
		listAllKeys(c.env, "userlinks:"),
	]);

	const users = new Map<string, UserAccumulator>();
	const migratedKeys: string[] = [];

	for (const key of userKeys) {
		const uid = key.slice("user:".length);
		const profile = (await kv.get(key, "json")) as Record<string, unknown> | null;
		if (!profile) continue;
		users.set(uid, {
			uid,
			walletAddress: typeof profile.walletAddress === "string" ? profile.walletAddress : null,
			username: typeof profile.username === "string" ? profile.username : null,
		});
		migratedKeys.push(key);
	}

	for (const key of credentialKeys) {
		const uid = key.slice("credential:".length);
		const credentialId = await kv.get(key);
		const existing: UserAccumulator = users.get(uid) ?? { uid };
		existing.credentialId = credentialId;
		users.set(uid, existing);
		migratedKeys.push(key);
	}

	for (const key of fundedKeys) {
		const uid = key.slice("funded:".length);
		const fundedAt = await kv.get(key);
		const existing: UserAccumulator = users.get(uid) ?? { uid };
		existing.fundedAt = fundedAt;
		users.set(uid, existing);
		migratedKeys.push(key);
	}

	for (const key of usernameKeys) {
		const username = key.slice("username:".length);
		const uid = await kv.get(key);
		if (!uid) continue;
		const existing: UserAccumulator = users.get(uid) ?? { uid };
		if (!existing.username) existing.username = username;
		users.set(uid, existing);
		migratedKeys.push(key);
	}

	let migratedUsers = users.size;
	if (!dryRun) {
		migratedUsers = 0;
		for (const user of users.values()) {
			await saveUser(c.env, {
				uid: user.uid,
				walletAddress: user.walletAddress ?? null,
				username: user.username ?? null,
				credentialId: user.credentialId ?? null,
				fundedAt: user.fundedAt ?? null,
			});
			migratedUsers += 1;
		}
	}

	let migratedLinks = 0;
	for (const key of linkKeys) {
		const legacy = (await kv.get(key, "json")) as any;
		if (!legacy) continue;
		migratedKeys.push(key);

		const link: PaymentLinkRecord = {
			id: String(legacy.id ?? key.slice("link:".length)),
			amount: String(legacy.amount ?? "0"),
			currency: String(legacy.currency ?? "USDC"),
			reference: String(legacy.reference ?? ""),
			wallet: String(legacy.wallet ?? ""),
			ownerUid: String(legacy.ownerUid ?? ""),
			status: legacy.status === "paid" ? "paid" : "pending",
			txHash: typeof legacy.txHash === "string" ? legacy.txHash : null,
			paidAt: typeof legacy.paidAt === "string" ? legacy.paidAt : null,
			paidBy: typeof legacy.paidBy === "string" ? legacy.paidBy : null,
			createdAt: typeof legacy.createdAt === "string" ? legacy.createdAt : new Date().toISOString(),
		};

		if (!dryRun) {
			await upsertPaymentLink(c.env, link);
		}
		migratedLinks += 1;
	}

	let migratedPending = 0;
	for (const key of pendingKeys) {
		const userOpHash = key.slice("pending:".length);
		const legacy = (await kv.get(key, "json")) as any;
		if (!legacy) continue;
		migratedKeys.push(key);

		if (!dryRun) {
			await createPendingPayment(c.env, {
				userOpHash,
				uid: String(legacy.uid ?? ""),
				linkId: legacy.linkId ? String(legacy.linkId) : null,
				wallet: String(legacy.wallet ?? ""),
				senderAddress: String(legacy.senderAddress ?? ""),
				amount: String(legacy.amount ?? "0"),
				currency: String(legacy.currency ?? "USDC"),
				userOp: (legacy.userOp ?? {}) as Record<string, unknown>,
			});
		}
		migratedPending += 1;
	}

	let migratedSent = 0;
	for (const key of sentKeys) {
		const uid = key.slice("sent:".length);
		const legacyItems = ((await kv.get(key, "json")) as any[] | null) ?? [];
		migratedKeys.push(key);

		for (const item of legacyItems) {
			if (!dryRun) {
				await recordSentTransaction(c.env, {
					uid,
					txHash: String(item.txHash ?? ""),
					amount: String(item.amount ?? "0"),
					currency: String(item.currency ?? "USDC"),
					to: String(item.to ?? ""),
					createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
				});
			}
			migratedSent += 1;
		}
	}

	for (const key of userLinksKeys) {
		migratedKeys.push(key);
	}

	if (!dryRun && purgeKv) {
		for (const key of Array.from(new Set(migratedKeys))) {
			await kv.delete(key);
		}
	}

	return c.json({
		success: true,
		dryRun,
		purgedKv: !dryRun && purgeKv,
		counts: {
			users: migratedUsers,
			links: migratedLinks,
			pendingPayments: migratedPending,
			sentTransactions: migratedSent,
			legacyUserLinksKeys: userLinksKeys.length,
			legacyKeysTouched: Array.from(new Set(migratedKeys)).length,
		},
	});
});

export default internalRoutes;

