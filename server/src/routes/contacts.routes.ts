// Contacts ("amigos") + invitation counter.
// Contacts are Parmelia users only (resolved by username against our own DB),
// so paying a contact is always paying a verified smart account.

import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	addContact,
	countInvitedUsers,
	deleteContact,
	getUserByUid,
	getUserByUsername,
	listContacts,
} from "../services/storage";

const contactsRoutes = new Hono<AppContext>();

contactsRoutes.get("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const contacts = await listContacts(c.env, user.sub);
	return c.json({
		contacts: contacts.map((ct) => ({
			id: ct.id,
			username: ct.username,
			alias: ct.alias,
			walletAddress: ct.walletAddress,
			createdAt: ct.createdAt,
		})),
	});
});

contactsRoutes.post("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const body = (await c.req.json()) as Record<string, unknown>;

	const username =
		typeof body.username === "string"
			? body.username.trim().toLowerCase().replace(/^@/, "")
			: "";
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return c.json({ error: "Escribe un usuario válido." }, 400);
	}

	const alias =
		typeof body.alias === "string" && body.alias.trim()
			? body.alias.trim().slice(0, 40)
			: null;

	const target = await getUserByUsername(c.env, username);
	if (!target || !target.walletAddress) {
		return c.json({ error: "Ese usuario no existe en Parmelia." }, 404);
	}
	if (target.uid === user.sub) {
		return c.json({ error: "No puedes agregarte a ti mismo." }, 400);
	}

	const contact = {
		id: crypto.randomUUID(),
		ownerUid: user.sub,
		contactUid: target.uid,
		username: target.username ?? username,
		walletAddress: target.walletAddress,
		alias,
		createdAt: new Date().toISOString(),
	};
	await addContact(c.env, contact);

	return c.json({
		contact: {
			id: contact.id,
			username: contact.username,
			alias: contact.alias,
			walletAddress: contact.walletAddress,
			createdAt: contact.createdAt,
		},
	});
});

contactsRoutes.delete("/:id", requireAuth, async (c) => {
	const user = c.get("user")!;
	const id = c.req.param("id");
	if (!id) return c.json({ error: "Falta el contacto." }, 400);
	await deleteContact(c.env, user.sub, id);
	return c.json({ success: true });
});

// Invitation stats: how many people created their account with my link.
contactsRoutes.get("/invites", requireAuth, async (c) => {
	const user = c.get("user")!;
	const [profile, invited] = await Promise.all([
		getUserByUid(c.env, user.sub),
		countInvitedUsers(c.env, user.sub),
	]);
	return c.json({
		invited,
		username: profile?.username ?? null,
	});
});

export default contactsRoutes;
