import { useEffect, useState, type ReactNode } from "react";
import { type User, logOut } from "../lib/firebase";
import { ApiError, SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { notifyError, notifySuccess, notifyWarning } from "../lib/notify";
import { createPasskey, signWithPasskey } from "../lib/webauthn";
import { enablePush, pushAlreadyEnabled, pushSupported } from "../lib/push";
import { activeNetwork } from "../lib/activeNetwork";
import { hexToBytes } from "../lib/hex";
import { useViewTransitionNavigate } from "../hooks/useNav";
import Turnstile from "../components/Turnstile";
import { Skeleton } from "../components/Skeleton";
import { useTranslation } from "react-i18next";
import i18n from "../lib/i18n";

const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

interface ProfileResponse {
	username?: string | null;
	walletAddress?: string | null;
}

interface PasskeyStatusResponse {
	signerCount: number | null;
	guardian: string | null;
	recoveryPending: boolean | null;
	recoveryExecutableAfter: string | null;
}

function isZeroAddress(address: string | null | undefined) {
	return !address || /^0x0{40}$/i.test(address);
}

function shortAddress(address: string) {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A titled content block with a colored accent badge. */
function Section({
	title,
	icon,
	accent,
	children,
}: {
	title?: string;
	icon?: ReactNode;
	accent?: string;
	children: ReactNode;
}) {
	return (
		<div className="mb-6">
			{title && (
				<div className="flex items-center gap-2.5 px-1 mb-2.5">
					{icon && (
						<span
							className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
							style={{ background: accent ? `${accent}22` : undefined, color: accent }}
						>
							{icon}
						</span>
					)}
					<h2 className="text-text-faint text-[12px] font-semibold uppercase tracking-[0.08em]">
						{title}
					</h2>
				</div>
			)}
			<div className="bg-surface border border-border rounded-[20px] overflow-hidden shadow-e1">
				{children}
			</div>
		</div>
	);
}

const ICON = {
	user: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="8" r="4" />
			<path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" />
		</svg>
	),
	card: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="6" width="18" height="13" rx="2" />
			<path d="M3 10h18" />
		</svg>
	),
	shield: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5l-8-3Z" />
		</svg>
	),
	coin: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v10M9.5 9.5a2.5 2 0 0 1 5 0c0 2-5 1-5 3a2.5 2 0 0 0 5 0" />
		</svg>
	),
	bell: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
			<path d="M13.73 21a2 2 0 0 1-3.46 0" />
		</svg>
	),
	globe: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="10" />
			<path d="M2 12h20" />
			<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
		</svg>
	),
};

/** Layout-matching placeholder for the initial settings fetch - profile header
 *  plus a few section-shaped cards, so there's no jump when the data lands. */
function SettingsSkeleton() {
	return (
		<div className="animate-fade-up" aria-hidden="true">
			<div className="flex items-center gap-4 mb-6 px-1">
				<Skeleton className="w-14 h-14 rounded-full shrink-0" />
				<div className="flex-1 flex flex-col gap-2">
					<Skeleton className="h-4 w-32 rounded-[6px]" />
					<Skeleton className="h-3 w-44 rounded-[6px]" />
				</div>
			</div>
			{[96, 84, 132, 188].map((h, i) => (
				<div key={i} className="mb-6">
					<Skeleton className="h-3 w-24 rounded-[6px] mb-2.5 ml-1" />
					<Skeleton className="w-full rounded-[20px]" style={{ height: h }} />
				</div>
			))}
		</div>
	);
}

export default function Settings({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const isSpanish = (i18n.resolvedLanguage || i18n.language || "es").startsWith("es");
	const [username, setUsername] = useState("");
	const [currentUsername, setCurrentUsername] = useState<string | null>(null);
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [copied, setCopied] = useState(false);
	const [passkeyStatus, setPasskeyStatus] =
		useState<PasskeyStatusResponse | null>(null);
	const [updatingPasskey, setUpdatingPasskey] = useState(false);
	const [faucetClaimed, setFaucetClaimed] = useState<boolean | null>(null);
	const [claimingFaucet, setClaimingFaucet] = useState(false);
	const [faucetToken, setFaucetToken] = useState<string | null>(null);
	const [pushOn, setPushOn] = useState(pushAlreadyEnabled());
	const [pushAvailable, setPushAvailable] = useState(false);
	const [pushBusy, setPushBusy] = useState(false);
	const [initialLoading, setInitialLoading] = useState(true);

	useEffect(() => {
		void pushSupported().then(setPushAvailable);
	}, []);

	async function fetchProfileData(): Promise<ProfileResponse | null> {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/profile`);
			if (!res.ok) return null;
			return (await res.json()) as ProfileResponse;
		} catch {
			return null;
		}
	}

	async function fetchPasskeyStatusData(): Promise<PasskeyStatusResponse | null> {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/passkey`);
			if (!res.ok) return null;
			return (await res.json()) as PasskeyStatusResponse;
		} catch {
			return null;
		}
	}

	async function fetchFaucetStatusData(): Promise<{ funded: boolean } | null> {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/fund`);
			if (!res.ok) return null;
			return (await res.json()) as { funded: boolean };
		} catch {
			return null;
		}
	}

	async function refreshSettings() {
		const [profileData, passkeyData, faucetData] = await Promise.all([
			fetchProfileData(),
			fetchPasskeyStatusData(),
			fetchFaucetStatusData(),
		]);

		setCurrentUsername(profileData?.username || null);
		setUsername(profileData?.username || "");
		setWalletAddress(profileData?.walletAddress || null);
		setPasskeyStatus(passkeyData);
		setFaucetClaimed(faucetData?.funded ?? null);
	}

	useEffect(() => {
		let cancelled = false;
		async function loadSettings() {
			setInitialLoading(true);
			await refreshSettings();
			if (!cancelled) setInitialLoading(false);
		}
		void loadSettings();
		return () => {
			cancelled = true;
		};
	}, [user]);

	async function handleSaveUsername() {
		if (!username.trim() || username === currentUsername) return;
		setSaving(true);
		try {
			const normalizedUsername = username.trim().toLowerCase();
			await apiFetch("/user/username", {
				user,
				method: "PUT",
				body: { username: normalizedUsername },
			});
			setCurrentUsername(normalizedUsername);
			notifySuccess(t("settings.usernameSaved"));
		} catch (err) {
			notifyError(err, t("settings.saveError"));
		} finally {
			setSaving(false);
		}
	}

	async function handleAddPasskey() {
		setUpdatingPasskey(true);
		try {
			if (!user.uid) throw new Error(t("common.sessionExpired"));
			const passkeyLabel = user.email || user.displayName || undefined;
			const nextPasskey = await createPasskey(user.uid, passkeyLabel);

			const intentData = await apiFetch<{ addSignerCalldata?: string }>(
				"/account/passkey",
				{ user, method: "PUT", body: nextPasskey },
			);
			if (!intentData.addSignerCalldata) {
				throw new Error(t("settings.missingKeyData"));
			}

			const { userOpHash, credentialId } = await apiFetch<{
				userOpHash: string;
				credentialId?: string | null;
			}>("/account/passkey/prepare", {
				user,
				body: { callData: intentData.addSignerCalldata },
			});

			const assertion = await signWithPasskey(
				hexToBytes(userOpHash),
				credentialId,
			);
			await apiFetch("/pay/submit", {
				user,
				body: {
					userOpHash,
					authenticatorData: assertion.authenticatorData,
					clientDataJSON: assertion.clientDataJSON,
					r: assertion.r,
					s: assertion.s,
					credentialId: assertion.credentialId,
					qx: assertion.qx,
					qy: assertion.qy,
				},
			});

			await refreshSettings();
			notifySuccess(t("settings.keyAdded"), t("settings.keyAddedDesc"));
		} catch (err) {
			notifyError(err, t("settings.keyAddError"));
		} finally {
			setUpdatingPasskey(false);
		}
	}

	async function handleEnablePush() {
		setPushBusy(true);
		try {
			const ok = await enablePush(user);
			if (ok) {
				setPushOn(true);
				notifySuccess(t("settings.pushOnTitle"), t("settings.pushOnDesc"));
			} else {
				notifyWarning(
					t("settings.pushFailTitle"),
					t("settings.pushFailDesc"),
				);
			}
		} catch (err) {
			notifyError(err, t("settings.pushError"));
		} finally {
			setPushBusy(false);
		}
	}

	async function handleClaimFaucet() {
		setClaimingFaucet(true);
		try {
			await apiFetch("/account/fund", { user, method: "POST", body: { turnstileToken: faucetToken } });
			setFaucetClaimed(true);
			notifySuccess(t("settings.faucetDoneTitle"), t("settings.faucetDoneDesc"));
		} catch (err) {
			// 409 = the one-time faucet was already claimed.
			if (err instanceof ApiError && err.status === 409) {
				setFaucetClaimed(true);
				notifyWarning(t("settings.faucetAlready"));
				return;
			}
			notifyError(err, t("settings.faucetError"));
		} finally {
			setClaimingFaucet(false);
		}
	}

	const recoveryDateLabel = passkeyStatus?.recoveryExecutableAfter
		? new Date(passkeyStatus.recoveryExecutableAfter).toLocaleDateString(i18n.resolvedLanguage || "es", {
				day: "numeric",
				month: "long",
		  })
		: null;
	const keyCount = passkeyStatus?.signerCount || 1;
	const recoveryOn = !isZeroAddress(passkeyStatus?.guardian);
	const usernameChanged = !!username.trim() && username !== currentUsername;

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_3rem)] w-full max-w-[460px] mx-auto">
			<header className="flex items-center gap-3 mb-7">
				<button
					onClick={() => navigate("/")}
					aria-label={t("common.back")}
					className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
				</button>
				<h1 className="text-[22px]">{t("common.settings")}</h1>
			</header>

			{initialLoading ? (
				<SettingsSkeleton />
			) : (
				<div className="animate-fade-up">
					{/* Profile */}
					<div className="flex items-center gap-4 mb-6 px-1">
						{user.photoURL ? (
							<img
								src={user.photoURL}
								alt=""
								referrerPolicy="no-referrer"
								className="w-14 h-14 rounded-full object-cover"
							/>
						) : (
							<div className="w-14 h-14 rounded-full bg-sky/15 flex items-center justify-center text-xl font-display text-sky">
								{(user.displayName || user.email || "?")[0].toUpperCase()}
							</div>
						)}
						<div className="min-w-0">
							{user.displayName && (
								<p className="font-display text-[18px] truncate">{user.displayName}</p>
							)}
							{user.email && (
								<p className="text-[13px] text-text-muted truncate">{user.email}</p>
							)}
						</div>
					</div>

					{/* Username */}
					<Section title={t("settings.usernameTitle")} icon={ICON.user} accent="#f4a9cf">
						<div className="p-5">
							<p className="text-[13px] text-text-muted mb-3">
								{t("settings.usernameDesc")}
							</p>
							<div className="flex items-center gap-2 bg-bg border border-border rounded-[14px] h-12 px-3.5 mb-3 focus-within:border-border-strong transition-colors">
								<span className="text-text-faint text-[14px]">
									{new URL(APP_URL).host}/
								</span>
								<input
									type="text"
									placeholder={t("settings.usernamePlaceholder")}
									value={username}
									onChange={(e) =>
										setUsername(e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase())
									}
									maxLength={30}
									className="flex-1 bg-transparent text-text text-[14px] placeholder:text-text-faint min-w-0"
								/>
							</div>
							<button
								onClick={handleSaveUsername}
								disabled={saving || !usernameChanged}
								className="btn btn-primary btn-sm"
							>
								{saving ? t("settings.saving") : t("settings.save")}
							</button>
						</div>
					</Section>

					{/* Contacts & invitations */}
					<Section title={t("settings.friends")} icon={ICON.user} accent="#9ce3f4">
						<button
							onClick={() => navigate("/contacts")}
							className="w-full flex items-center justify-between p-5 hover:bg-surface-2 transition-colors text-left"
						>
							<div>
								<p className="text-[15px] mb-0.5">{t("settings.contactsTitle")}</p>
								<p className="text-[13px] text-text-muted">
									{t("settings.contactsDesc")}
								</p>
							</div>
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0 ml-3">
								<path d="m9 18 6-6-6-6" />
							</svg>
						</button>
					</Section>

					{/* Account / address */}
					{walletAddress && (
						<Section title={t("settings.accountTitle")} icon={ICON.card} accent="#efe08c">
							<div className="p-5">
								<div className="flex items-center justify-between mb-1.5">
									<span className="text-[13px] text-text-muted">{t("settings.address")}</span>
									<span className="text-[11px] px-2.5 py-1 rounded-full bg-white/[0.06] text-text-muted">
										{activeNetwork.name}
									</span>
								</div>
								<p className="font-mono text-[14px] text-text mb-4 tabular">
									{shortAddress(walletAddress)}
								</p>
								<div className="flex gap-2.5">
									<button
										onClick={() => {
											navigator.clipboard.writeText(walletAddress);
											notifySuccess(t("settings.addressCopied"));
											setCopied(true);
											setTimeout(() => setCopied(false), 2000);
										}}
										className="btn btn-ghost btn-sm flex-1"
									>
										{copied ? t("common.copied") : t("common.copy")}
									</button>
									<a
										href={`${activeNetwork.explorerBaseUrl}/address/${walletAddress}`}
										target="_blank"
										rel="noopener noreferrer"
										className="btn btn-ghost btn-sm flex-1"
									>
										{t("settings.viewExplorer")}
									</a>
								</div>
							</div>
						</Section>
					)}

					{/* Security */}
					{walletAddress && (
						<Section title={t("settings.security")} icon={ICON.shield} accent="#9ce3f4">
							<div className="p-5">
								<div className="flex items-start gap-3 mb-4">
									<div className="w-9 h-9 rounded-full bg-sky/15 flex items-center justify-center shrink-0 mt-0.5">
										<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M12 1a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V5a4 4 0 0 0-4-4Z" />
											<circle cx="12" cy="14" r="1.5" fill="#9ce3f4" stroke="none" />
										</svg>
									</div>
									<div>
										<p className="font-display text-[16px] leading-tight">
											{t("settings.fingerprintKeyTitle")}
										</p>
										<p className="text-[13px] text-text-muted leading-relaxed mt-1">
											{t("settings.fingerprintKeyDesc")}
										</p>
									</div>
								</div>

								<div className="flex gap-2.5 mb-4">
									<div className="flex-1 bg-surface-2 rounded-[14px] px-3.5 py-3">
										<p className="font-display text-[20px] text-sky tabular">{keyCount}</p>
										<p className="text-[12px] text-text-muted mt-0.5">
											{t("settings.keyActive", { count: keyCount })}
										</p>
									</div>
									<div className="flex-1 bg-surface-2 rounded-[14px] px-3.5 py-3">
										<p className="font-display text-[20px] text-cream">
											{recoveryOn ? t("settings.yes") : "-"}
										</p>
										<p className="text-[12px] text-text-muted mt-0.5">{t("settings.recovery")}</p>
									</div>
								</div>

								{passkeyStatus?.recoveryPending && (
									<div className="bg-glow-pink/10 border border-glow-pink/20 rounded-[14px] p-3.5 mb-4">
										<p className="text-[13px] text-glow-pink leading-relaxed">
											{t("settings.recoveryPending")}
											{recoveryDateLabel ? t("settings.recoveryAvailableOn", { date: recoveryDateLabel }) : ""}.
										</p>
									</div>
								)}

								<button
									onClick={handleAddPasskey}
									disabled={updatingPasskey}
									className="btn btn-ghost btn-block"
								>
									{updatingPasskey ? t("settings.addingKey") : t("settings.addBackupKey")}
								</button>
								<p className="text-[12px] text-text-faint leading-relaxed mt-2.5 px-0.5">
									{t("settings.addBackupKeyDesc")}
								</p>
							</div>
						</Section>
					)}

					{/* Test funds */}
					{walletAddress && (
						<Section title={t("settings.testFunds")} icon={ICON.coin} accent="#efe08c">
							<div className="p-5">
								{faucetClaimed === null ? (
									<p className="text-[13px] text-text-muted">{t("common.loading")}</p>
								) : faucetClaimed ? (
									<>
										<p className="text-[13px] text-text-muted leading-relaxed mb-3">
											{t("settings.faucetClaimedDesc")}
											{activeNetwork.faucetUrl ? t("settings.faucetNeedMore") : ""}
										</p>
										{activeNetwork.faucetUrl && (
											<a
												href={activeNetwork.faucetUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="btn btn-ghost btn-sm"
											>
												{t("settings.openFaucet", { label: activeNetwork.faucetLabel })}
											</a>
										)}
									</>
								) : (
									<>
										<p className="text-[13px] text-text-muted leading-relaxed mb-3">
											{t("settings.faucetIntro")}
										</p>
										<div className="mb-3">
											<Turnstile onToken={setFaucetToken} />
										</div>
										<button
											onClick={handleClaimFaucet}
											disabled={claimingFaucet || faucetToken === null}
											className="btn btn-primary btn-sm"
										>
											{claimingFaucet ? t("settings.sending") : t("settings.getTestFunds")}
										</button>
									</>
								)}
							</div>
						</Section>
					)}

					{/* Notifications */}
					{walletAddress && pushAvailable && !pushOn && (
						<Section title={t("settings.notifications")} icon={ICON.bell} accent="#9ce3f4">
							<div className="p-5">
								<p className="text-[13px] text-text-muted leading-relaxed mb-3">
									{t("settings.pushIntro")}
								</p>
								<button
									onClick={handleEnablePush}
									disabled={pushBusy}
									className="btn btn-primary btn-sm"
								>
									{pushBusy ? t("settings.activating") : t("settings.enablePush")}
								</button>
							</div>
						</Section>
					)}
					{walletAddress && pushOn && (
						<Section title={t("settings.notifications")} icon={ICON.bell} accent="#9ce3f4">
							<div className="p-5 flex items-center gap-2.5">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<polyline points="20 6 9 17 4 12" />
								</svg>
								<p className="text-[14px] text-text-muted">{t("settings.pushEnabled")}</p>
							</div>
						</Section>
					)}

					{/* Language */}
						<Section title={t("settings.language")} icon={ICON.globe} accent="#efe08c">
							<div className="p-5">
								<p className="text-[13px] text-text-muted mb-3">{t("settings.languageDesc")}</p>
								<div className="seg-track seg-track-block">
									<button
										onClick={() => void i18n.changeLanguage("es")}
										data-active={isSpanish}
										className="seg-item"
									>
										Español
									</button>
									<button
										onClick={() => void i18n.changeLanguage("en")}
										data-active={!isSpanish}
										className="seg-item"
									>
										English
									</button>
								</div>
							</div>
						</Section>

						{/* Logout */}
					<button
						onClick={() => logOut()}
						className="btn btn-block text-danger border border-danger/45 hover:bg-danger/10"
					>
						{t("settings.logout")}
					</button>
				</div>
			)}
		</div>
	);
}
