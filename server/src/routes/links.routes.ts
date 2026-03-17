import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	createPaymentLink,
	getPaymentLinkById,
	getUserByUid,
	listPaymentLinksByOwner,
	type PaymentLinkRecord,
} from "../services/storage";

const linksRoutes = new Hono<AppContext>();

function normalizeLinkAmount(amount: unknown): { value?: string; error?: string } {
	if (amount === undefined || amount === null) {
		return { value: "0" };
	}

	const normalized = String(amount).trim();
	if (!normalized) {
		return { value: "0" };
	}

	const numeric = Number(normalized);
	if (!Number.isFinite(numeric)) {
		return { error: "Amount must be a valid number or empty" };
	}
	if (numeric < 0) {
		return { error: "Amount cannot be negative" };
	}

	return { value: numeric === 0 ? "0" : normalized };
}

function normalizeCurrency(currency: unknown): "USDC" | "ETH" | null {
	if (currency === undefined || currency === null || String(currency).trim() === "") {
		return "USDC";
	}

	const normalized = String(currency).trim().toUpperCase();
	if (normalized === "USDC" || normalized === "ETH") {
		return normalized;
	}

	return null;
}

function normalizeReference(reference: unknown): string {
	return typeof reference === "string" ? reference.trim() : "";
}

linksRoutes.post("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const { amount, currency, reference } = await c.req.json();

	const normalizedAmount = normalizeLinkAmount(amount);
	if (normalizedAmount.error) {
		return c.json({ error: normalizedAmount.error }, 400);
	}

	const normalizedCurrency = normalizeCurrency(currency);
	if (!normalizedCurrency) {
		return c.json({ error: "Currency must be USDC or ETH" }, 400);
	}

	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;

	if (!walletAddress) {
		return c.json({ error: "Necesitas crear una wallet antes de crear un link de cobro" }, 400);
	}

	const link: PaymentLinkRecord = {
		id: crypto.randomUUID(),
		amount: normalizedAmount.value ?? "0",
		currency: normalizedCurrency,
		reference: normalizeReference(reference),
		wallet: walletAddress,
		ownerUid: user.sub,
		status: "pending",
		txHash: null,
		paidAt: null,
		paidBy: null,
		createdAt: new Date().toISOString(),
	};

	await createPaymentLink(c.env, link);

	return c.json(link);
});

linksRoutes.get("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const links = await listPaymentLinksByOwner(c.env, user.sub, 20);
	return c.json({ links });
});

linksRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const link = await getPaymentLinkById(c.env, id);
	if (!link) return c.json({ error: "Link not found" }, 404);
	return c.json(link);
});

export default linksRoutes;
