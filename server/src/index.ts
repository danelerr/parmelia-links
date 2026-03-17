import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { AppContext, authMiddleware } from "./middlewares/auth";

import userRoutes from "./routes/user.routes";
import accountRoutes from "./routes/account.routes";
import linksRoutes from "./routes/links.routes";
import txRoutes from "./routes/transactions.routes";
import payRoutes from "./routes/pay.routes";
import internalRoutes from "./routes/internal.routes";

const app = new Hono<AppContext>();

// Global Middlewares
app.use(
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "x-storage-migration-token"],
	}),
);
app.use(logger());
app.use(authMiddleware);

// Healthcheck
app.get("/", (c) => c.text("Parmelia Links API (Modular)"));

// Mount Routes
app.route("/internal/storage", internalRoutes);
app.route("/user/transactions", txRoutes);
app.route("/user", userRoutes);
app.route("/account", accountRoutes);
app.route("/links", linksRoutes);
app.route("/pay", payRoutes);

export default app;
