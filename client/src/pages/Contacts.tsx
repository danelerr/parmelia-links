// Contacts ("amigos"): save Parmelia users, pay them in one tap, invite new
// people with your link and see how many joined.

import { useCallback, useEffect, useState } from "react";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { notifyError, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import Logo from "../components/Logo";
import { RowSkeletonList } from "../components/Skeleton";
import { useViewTransitionNavigate } from "../hooks/useNav";

const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

type Contact = {
	id: string;
	username: string;
	alias: string | null;
	walletAddress: string;
	createdAt: string;
};

export default function Contacts({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [contacts, setContacts] = useState<Contact[]>([]);
	const [loading, setLoading] = useState(true);
	const [newUsername, setNewUsername] = useState("");
	const [adding, setAdding] = useState(false);
	const [invited, setInvited] = useState<number | null>(null);
	const [myUsername, setMyUsername] = useState<string | null>(null);
	const [referralCode, setReferralCode] = useState<string | null>(null);

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
			const data = await apiFetch<{ contact: Contact }>("/contacts", {
				user,
				body: { username },
			});
			setContacts((prev) => [data.contact, ...prev.filter((c) => c.id !== data.contact.id)]);
			setNewUsername("");
			notifySuccess("Contacto agregado");
		} catch (err) {
			notifyError(err, "No se pudo agregar");
		} finally {
			setAdding(false);
		}
	}

	async function handleDelete(id: string) {
		setContacts((prev) => prev.filter((c) => c.id !== id));
		await fetchWithAuth(user, `${SERVER_URL}/contacts/${id}`, { method: "DELETE" }).catch(() => {
			void load();
		});
	}

	const inviteRef = referralCode || myUsername;
	const inviteUrl = inviteRef ? `${APP_URL}/?ref=${inviteRef}` : APP_URL;

	async function handleInvite() {
		track("invite_shared");
		const text = "Únete a Parmelia: cobra y paga dinero digital como mandar un mensaje.";
		if (navigator.share) {
			try {
				await navigator.share({ title: "Parmelia", text, url: inviteUrl });
				return;
			} catch {
				/* cancelled */
			}
		} else {
			navigator.clipboard.writeText(inviteUrl);
			notifySuccess("Link de invitación copiado");
		}
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_3rem)] w-full max-w-[460px] mx-auto animate-fade-up">
			<header className="flex items-center gap-3 mb-7">
				<button
					onClick={() => navigate("/settings")}
					aria-label="Volver"
					className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
				</button>
				<h1 className="text-[22px]">Contactos</h1>
			</header>

			{/* Invite card */}
			<div className="relative overflow-hidden bg-surface border border-border rounded-[20px] p-5 mb-6 shadow-e1">
				<div
					className="pointer-events-none absolute -top-16 -right-12 w-44 h-44 rounded-full opacity-[0.16] blur-2xl"
					style={{ background: "radial-gradient(circle,#f4a9cf,transparent 70%)" }}
				/>
				<div className="flex items-center justify-between gap-3 relative z-1">
					<div className="min-w-0 flex-1">
						<p className="font-display text-[17px] mb-1">Invita a tus amigos</p>
						<p className="text-[13px] text-text-muted leading-relaxed">
							{invited === null
								? "Comparte tu código y cobra/paga entre amigos."
								: invited === 0
									? "Aún nadie se unió con tu código. ¡Compártelo!"
									: `${invited} ${invited === 1 ? "amigo se unió" : "amigos se unieron"} con tu invitación`}
						</p>
					</div>
					<button onClick={handleInvite} className="btn btn-primary btn-sm shrink-0">
						Invitar
					</button>
				</div>
				{referralCode && (
					<button
						onClick={() => {
							navigator.clipboard.writeText(referralCode);
							notifySuccess("Código copiado");
						}}
						className="mt-3.5 flex items-center gap-2.5 px-3.5 py-2 rounded-full bg-bg/60 border border-border hover:border-border-strong transition-colors relative z-1"
					>
						<span className="text-[12px] text-text-faint">Tu código</span>
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
						value={newUsername}
						onChange={(e) => setNewUsername(e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase())}
						onKeyDown={(e) => e.key === "Enter" && handleAdd()}
						placeholder="usuario"
						maxLength={30}
						className="flex-1 bg-transparent text-[14px] text-text placeholder:text-text-faint min-w-0"
					/>
				</div>
				<button
					onClick={handleAdd}
					disabled={adding || !newUsername.trim()}
					className="btn btn-primary btn-sm h-12 shrink-0"
				>
					{adding ? "…" : "Agregar"}
				</button>
			</div>

			{/* List */}
			{loading ? (
				<RowSkeletonList count={5} />
			) : contacts.length === 0 ? (
				<div className="flex flex-col items-center text-center py-12 px-6">
					<Logo className="w-10 mb-4 opacity-40" />
					<p className="text-[14px] text-text-muted max-w-[240px] leading-relaxed">
						Agrega a tus amigos por su usuario para pagarles en un toque.
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{contacts.map((ct) => (
						<div
							key={ct.id}
							className="flex items-center gap-3.5 py-3 px-2 -mx-2 rounded-[14px] hover:bg-surface transition-colors"
						>
							<button
								onClick={() => navigate(`/${ct.username}`)}
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
							</button>
							<button
								onClick={() => navigate(`/${ct.username}`)}
								className="text-[13px] text-glow-sky shrink-0 px-2 py-1.5"
							>
								Pagar
							</button>
							<button
								onClick={() => handleDelete(ct.id)}
								aria-label={`Eliminar ${ct.username}`}
								className="w-8 h-8 rounded-full flex items-center justify-center text-text-faint hover:text-glow-pink hover:bg-glow-pink/10 transition-colors shrink-0"
							>
								<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M3 6h18" />
									<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
									<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
								</svg>
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
