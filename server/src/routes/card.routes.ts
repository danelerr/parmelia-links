import { Hono } from "hono";
import { ERR } from "../../../shared";
import { type AppContext, requireAuth } from "../middlewares/auth";
import { logInfo } from "../services/logger";

const cardRoutes = new Hono<AppContext>();

const USE_CASES = new Set(["subscriptions", "online", "travel", "advertising", "daily", "other"]);
const MONTHLY_SPEND = new Set(["under-100", "100-500", "500-1000", "over-1000", "prefer-not"]);
const CARD_PREFERENCES = new Set(["virtual", "physical", "both"]);
const WALLET_PAY_IMPORTANCE = new Set(["essential", "important", "not-important"]);

type CardInterestRow = {
	country: string;
	use_case: string;
	monthly_spend: string;
	card_preference: string;
	wallet_pay_importance: string;
	updated_at: string;
};

function payload(row: CardInterestRow | null) {
	if (!row) return { interest: null };
	return {
		interest: {
			country: row.country,
			useCase: row.use_case,
			monthlySpend: row.monthly_spend,
			cardPreference: row.card_preference,
			walletPayImportance: row.wallet_pay_importance,
			updatedAt: row.updated_at,
		},
	};
}

cardRoutes.get("/interest", requireAuth, async (c) => {
	const uid = c.get("user")!.sub;
	const row = await c.env.GATOPAGO_DB.prepare(
		`SELECT country, use_case, monthly_spend, card_preference,
		        wallet_pay_importance, updated_at
		 FROM card_interest WHERE uid = ? LIMIT 1`,
	).bind(uid).first<CardInterestRow>();
	return c.json(payload(row));
});

cardRoutes.put("/interest", requireAuth, async (c) => {
	const uid = c.get("user")!.sub;
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	const country = typeof body?.country === "string" ? body.country.trim() : "";
	const useCase = typeof body?.useCase === "string" ? body.useCase : "";
	const monthlySpend = typeof body?.monthlySpend === "string" ? body.monthlySpend : "";
	const cardPreference = typeof body?.cardPreference === "string" ? body.cardPreference : "";
	const walletPayImportance = typeof body?.walletPayImportance === "string" ? body.walletPayImportance : "";
	if (
		country.length < 2 || country.length > 80 ||
		!USE_CASES.has(useCase) ||
		!MONTHLY_SPEND.has(monthlySpend) ||
		!CARD_PREFERENCES.has(cardPreference) ||
		!WALLET_PAY_IMPORTANCE.has(walletPayImportance)
	) {
		return c.json({ error: "Invalid card interest", error_code: ERR.INVALID_PROFILE, requestId: c.get("requestId") }, 400);
	}

	const now = new Date().toISOString();
	await c.env.GATOPAGO_DB.prepare(
		`INSERT INTO card_interest (
		   uid, country, use_case, monthly_spend, card_preference,
		   wallet_pay_importance, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(uid) DO UPDATE SET
		   country = excluded.country,
		   use_case = excluded.use_case,
		   monthly_spend = excluded.monthly_spend,
		   card_preference = excluded.card_preference,
		   wallet_pay_importance = excluded.wallet_pay_importance,
		   updated_at = excluded.updated_at`,
	).bind(uid, country, useCase, monthlySpend, cardPreference, walletPayImportance, now, now).run();
	logInfo("card_interest_saved", { uid, requestId: c.get("requestId") });
	return c.json(payload({
		country,
		use_case: useCase,
		monthly_spend: monthlySpend,
		card_preference: cardPreference,
		wallet_pay_importance: walletPayImportance,
		updated_at: now,
	}));
});

export default cardRoutes;
