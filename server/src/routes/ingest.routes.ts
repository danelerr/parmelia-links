import { Hono } from "hono";
import { type AppContext } from "../middlewares/auth";
import { processAlchemyWebhook } from "../services/alchemyWebhook";
import { logWarn } from "../services/logger";

const ingestRoutes = new Hono<AppContext>();

ingestRoutes.post("/alchemy", async (c) => {
	const rawBody = await c.req.text();
	const result = await processAlchemyWebhook(
		c.env,
		rawBody,
		c.req.header("X-Alchemy-Signature"),
	);
	if (result.status === "disabled") return c.notFound();
	if (result.status === "invalid_signature") {
		logWarn("alchemy_webhook_rejected", {
			requestId: c.get("requestId"),
			reason: "invalid_signature",
		});
		return c.json({ error: "Invalid webhook signature" }, 401);
	}
	if (result.status === "invalid_payload") {
		return c.json({ error: "Invalid webhook payload" }, 400);
	}
	if (result.status === "rejected_scope") {
		return c.json({ error: "Webhook scope mismatch" }, 403);
	}
	return c.json({
		accepted: true,
		duplicate: result.status === "duplicate",
		events: result.events,
	}, 200);
});

export default ingestRoutes;
