// Contacts ("amigos"): save Parmelia users, pay them in one tap, invite new
// people with your link and see how many joined.

import { useCallback, useEffect, useState } from "react";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { notifyError, notifyPromise, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import Logo from "../components/Logo";
import LinkButton from "../components/LinkButton";
import BackHeader from "../components/BackHeader";
import { RowSkeletonList } from "../components/Skeleton";
import { useTranslation } from "react-i18next";

const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

type Contact = {
	id: string;
	username: string;
	alias: string | null;
	walletAddress: string;
	createdAt: string;
};

export default function Contacts({ user }: { user: User }) {
	const { t } = useTranslation();
	const [contacts, setContacts] = useState<Contact[]>([]);
	const [loading, setLoading] = useState(true);
	const [newUsername, setNewUsername] = useState("");
	const [adding, setAdding] = useState(false);
	const [invited, setInvited] = useState<number | null>(null);
	const [myUsername, setMyUsername] = useState<string | null>(null);
	const [referralCode, setReferralCode] = useState<string | null>(null);
	// Row whose delete is awaiting inline confirmation.
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [contactsRes, invitesRes] = await Promise.all([
				fetchWithAuth(user, `${SERVER_URL}/contacts`),
				fetchWithAuth(user, `${SERVER_URL}/contacts/invites`),
			]);
			if (contactsRes.ok) {
				const data = await contactsRes.json();
				setContacts(data.contacts || []);
			}
			if (invitesRes.ok) {
				const data = await invitesRes.json();
				setInvited(data.invited ?? 0);
				setMyUsername(data.username ?? null);
				setReferralCode(data.referralCode ?? null);
			}
		} finally {
			setLoading(false);
		}
	}, [user]);

	useEffect(() => {
		void load();
	}, [load]);

	async function handleAdd() {
		const username = newUsername.trim();
		if (!username) return;
		setAdding(true);
		try {
			const data = await notifyPromise(
				apiFetch<{ contact: Contact }>("/contacts", {
					user,
					body: { username },
				}),
				{
					loading: t("contacts.adding"),
					success: t("contacts.added"),
					error: t("contacts.addError"),
				},
			);
			setContacts((prev) => [data.contact, ...prev.filter((c) => c.id !== data.contact.id)]);
			setNewUsername("");
		} catch {
			// notifyPromise already surfaced the error toast.
		} finally {
			setAdding(false);
		}
	}

	// Optimistic removal WITH rollback: if the DELETE fails the row comes back
	// and the user is told, so the list never lies about what the server has.
	async function handleDelete(id: string) {
		setConfirmDeleteId(null);
		const previous = contacts;
		setContacts((prev) => prev.filter((c) => c.id !== id));
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/contacts/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error();
		} catch {
			setContacts(previous);
			notifyError(new Error(t("contacts.deleteError")));
		}
	}

	const inviteRef = referralCode || myUsername;
	const inviteUrl = inviteRef ? `${APP_URL}/?ref=${inviteRef}` : APP_URL;

	async function handleInvite() {
		track("invite_shared");
		const text = t("contacts.inviteText");
		if (navigator.share) {
			try {
				await navigator.share({ title: "Parmelia", text, url: inviteUrl });
				return;
			} catch {
				/* cancelled */
			}
		} else {
			navigator.clipboard.writeText(inviteUrl);
			notifySuccess(t("contacts.inviteLinkCopied"));
		}
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_3rem)] w-full max-w-[460px] mx-auto animate-fade-up">
			<BackHeader to="/settings" title={t("contacts.title")} />

			{/* Invite card */}
			<div className="relative overflow-hidden bg-surface border border-border rounded-[20px] p-5 mb-6 shadow-e1">
				<div
					className="pointer-events-none absolute -top-16 -right-12 w-44 h-44 rounded-full opacity-[0.16] blur-2xl"
					style={{ background: "radial-gradient(circle,#f4a9cf,transparent 70%)" }}
				/>
				<div className="flex items-center justify-between gap-3 relative z-1">
					<div className="min-w-0 flex-1">
						<p className="font-display text-[17px] mb-1">{t("contacts.inviteTitle")}</p>
						<p className="text-[13px] text-text-muted leading-relaxed">
							{invited === null
								? t("contacts.inviteDefault")
								: invited === 0
									? t("contacts.inviteNone")
									: t("contacts.invited", { count: invited })}
						</p>
					</div>
					<button onClick={handleInvite} className="btn btn-primary btn-sm shrink-0">
						{t("contacts.invite")}
					</button>
				</div>
				{referralCode && (
					<button
						onClick={() => {
							navigator.clipboard.writeText(referralCode);
							notifySuccess(t("contacts.codeCopied"));
						}}
						className="mt-3.5 flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-bg/60 border border-border hover:border-border-strong transition-colors relative z-1"
					>
						<span className="text-[12px] text-text-faint">{t("contacts.yourCode")}</span>
						<span className="font-mono text-[14px] tracking-[0.2em] text-glow-gold">
							{referralCode}
						</span>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint">
							<rect x="9" y="9" width="13" height="13" rx="2" />
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
						</svg>
					</button>
				)}
			</div>

			{/* Add contact */}
			<div className="flex gap-2 mb-6">
				<div className="flex-1 min-w-0 flex items-center gap-1.5 bg-surface border border-border rounded-full h-12 px-4 focus-within:border-border-strong transition-colors">
					<span className="text-text-faint text-[14px] shrink-0">@</span>
					<input
						type="text"
						name="username"
						autoComplete="off"
						aria-label={t("contacts.usernameLabel")}
						value={newUsername}
						onChange={(e) => setNewUsername(e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase())}
						onKeyDown={(e) => e.key === "Enter" && handleAdd()}
						placeholder={t("contacts.usernamePlaceholder")}
						maxLength={30}
						className="flex-1 bg-transparent text-[14px] text-text placeholder:text-text-faint min-w-0"
					/>
				</div>
				<button
					onClick={handleAdd}
					disabled={adding || !newUsername.trim()}
					className="btn btn-primary btn-sm h-12 shrink-0"
				>
					{adding ? "…" : t("contacts.add")}
				</button>
			</div>

			{/* List */}
			{loading ? (
				<RowSkeletonList count={5} />
			) : contacts.length === 0 ? (
				<div className="flex flex-col items-center text-center py-12 px-6">
					<Logo className="w-10 mb-4 opacity-40" />
					<p className="text-[14px] text-text-muted max-w-[240px] leading-relaxed">
						{t("contacts.emptyBody")}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{contacts.map((ct) => (
						<div
							key={ct.id}
							className="flex items-center gap-3.5 py-3 px-2 -mx-2 rounded-[14px] hover:bg-surface transition-colors"
						>
							<LinkButton
								to={`/${ct.username}`}
								className="flex items-center gap-3.5 flex-1 min-w-0 text-left"
							>
								<span className="w-10 h-10 rounded-full bg-pink/15 text-glow-pink font-display flex items-center justify-center uppercase shrink-0">
									{(ct.alias || ct.username)[0]}
								</span>
								<span className="min-w-0">
									<span className="block text-[15px] truncate">{ct.alias || `@${ct.username}`}</span>
									{ct.alias && (
										<span className="block text-[12px] text-text-faint truncate">@{ct.username}</span>
									)}
								</span>
							</LinkButton>
							{confirmDeleteId === ct.id ? (
								// Inline confirmation - deleting is one tap too easy otherwise.
								<div className="flex items-center gap-1 shrink-0">
									<button
										onClick={() => handleDelete(ct.id)}
										className="text-[13px] text-danger font-medium px-2.5 py-1.5 rounded-full hover:bg-danger/10 transition-colors"
									>
										{t("contacts.deleteConfirm")}
									</button>
									<button
										onClick={() => setConfirmDeleteId(null)}
										className="text-[13px] text-text-muted px-2 py-1.5 rounded-full hover:bg-surface-2 transition-colors"
									>
										{t("common.cancel")}
									</button>
								</div>
							) : (
								<>
									<LinkButton
										to={`/${ct.username}`}
										className="text-[13px] text-glow-sky shrink-0 px-2 py-1.5"
									>
										{t("contacts.pay")}
									</LinkButton>
									<button
										onClick={() => setConfirmDeleteId(ct.id)}
										aria-label={t("contacts.deleteAria", { username: ct.username })}
										className="w-8 h-8 rounded-full flex items-center justify-center text-text-faint hover:text-glow-pink hover:bg-glow-pink/10 transition-colors shrink-0"
									>
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M3 6h18" />
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
											<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
										</svg>
									</button>
								</>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
