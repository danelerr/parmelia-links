// Contacts ("amigos"): save GatoPago users, pay them in one tap, invite new
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
import { APP_URL } from "../lib/brand";

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
				await navigator.share({ title: "GatoPago", text, url: inviteUrl });
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
		<div className="app-frame relative flex min-h-dvh w-full max-w-[480px] flex-col px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_3rem)] mx-auto animate-fade-up">
			<BackHeader title={t("contacts.title")} />

			{/* Invite card */}
			<div className="meli-paper-card meli-paper-card--strong relative mb-6 overflow-hidden p-5">
				<div className="pointer-events-none absolute right-5 top-0 h-1 w-12 bg-cat-500 shadow-[8px_4px_0_var(--color-cat-700)]" />
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
						className="relative z-1 mt-3.5 flex items-center gap-2.5 border border-border bg-surface-2 px-3.5 py-2"
					>
						<span className="text-[12px] text-text-faint">{t("contacts.yourCode")}</span>
						<span className="font-mono text-[14px] tracking-[0.2em] text-pending">
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
				<div className="min-w-0 flex h-12 flex-1 items-center gap-1.5 border-2 border-text bg-surface px-4">
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
				<div className="meli-paper-card flex flex-col">
					{contacts.map((ct) => (
						<div
							key={ct.id}
							className="flex items-center gap-3.5 border-b border-border px-3 py-3 last:border-b-0"
						>
							<LinkButton
								to={`/${ct.username}`}
								className="flex items-center gap-3.5 flex-1 min-w-0 text-left"
							>
								<span className="flex h-10 w-10 shrink-0 items-center justify-center border border-text bg-cat-500 font-display uppercase text-on-cat">
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
										className="rounded-full bg-danger/10 px-2.5 py-1.5 text-[13px] font-medium text-danger"
									>
										{t("contacts.deleteConfirm")}
									</button>
									<button
										onClick={() => setConfirmDeleteId(null)}
										className="rounded-full bg-surface-2 px-2 py-1.5 text-[13px] text-text-muted"
									>
										{t("common.cancel")}
									</button>
								</div>
							) : (
								<>
									<LinkButton
										to={`/${ct.username}`}
									className="shrink-0 px-2 py-1.5 text-[13px] font-semibold text-cat-300"
									>
										{t("contacts.pay")}
									</LinkButton>
									<button
										onClick={() => setConfirmDeleteId(ct.id)}
										aria-label={t("contacts.deleteAria", { username: ct.username })}
										className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-faint"
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
