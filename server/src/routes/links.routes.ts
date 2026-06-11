import { Hono } from "hono";
import { getNetworkConfig } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	createPaymentLink,
	getPaymentLinkById,
	getUserByUid,
	listPaymentLinksByOwner,
	type PaymentLinkRecord,
} from "../services/storage";
import {
	normalizeCurrency,
	normalizeLinkAmount,
	normalizeReference,
} from "../services/validation";

const linksRoutes = new Hono<AppContext>();

linksRoutes.post("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const { amount, currency, reference } = await c.req.json();

	const normalizedAmount = normalizeLinkAmount(amount);
	if (normalizedAmount.error) {
		return c.json({ error: normalizedAmount.error }, 400);
	}

	const network = getNetworkConfig(c.env.CHAIN_KEY);
	const allowedCurrencies = network.tokens.length
		? network.tokens.map((t) => t.symbol)
		: ["USDC", "ETH"];
	const normalizedCurrency = normalizeCurrency(currency, allowedCurrencies, "USDC");
	if (!normalizedCurrency) {
		return c.json({ error: `Moneda no soportada (usa ${allowedCurrencies.join(", ")})` }, 400);
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
