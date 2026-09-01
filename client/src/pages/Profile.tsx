import { useState } from "react";
import { mutate as mutateSWR } from "swr";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import type { HomeReadModel } from "../lib/homeData";
import { notifyPromise, notifySuccess } from "../lib/notify";
import { activeNetwork } from "../lib/activeNetwork";
import { useAccountProfile, type AccountProfile } from "../hooks/useAccountProfile";
import { useTranslation } from "react-i18next";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import { SettingsPageSkeleton, SettingsSection } from "../components/SettingsSection";
import MeliRoom from "../components/brand/MeliRoom";
import { APP_URL } from "../lib/brand";
import { useChainPortfolio } from "../hooks/useChainPortfolio";

const USER_ICON = (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<circle cx="12" cy="8" r="4" />
		<path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" />
	</svg>
);

const WALLET_ICON = (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
		<rect x="3" y="6" width="18" height="13" rx="2" />
		<path d="M3 10h18" />
	</svg>
);

export default function Profile({ user }: { user: User }) {
	const { t } = useTranslation();
	const { profile, loading } = useAccountProfile(user);

	return (
		<Screen className="pb-[calc(env(safe-area-inset-bottom)_+_3rem)]">
			<BackHeader title={t("menu.profile")} />
			{loading || !profile ? (
				<SettingsPageSkeleton />
			) : (
				<ProfileEditor
					key={JSON.stringify([
						profile.username,
						profile.displayName,
						profile.socialUrl,
						profile.walletAddress,
					])}
					user={user}
					profile={profile}
				/>
			)}
		</Screen>
	);
}

function ProfileEditor({ user, profile }: { user: User; profile: AccountProfile }) {
	const { t } = useTranslation();
	const { data: portfolio } = useChainPortfolio(user);
	const [username, setUsername] = useState(profile.username || "");
	const [currentUsername, setCurrentUsername] = useState<string | null>(profile.username);
	const [displayName, setDisplayName] = useState(profile.displayName || "");
	const [socialUrl, setSocialUrl] = useState(profile.socialUrl || "");
	const [savedProfile, setSavedProfile] = useState({
		displayName: profile.displayName || "",
		socialUrl: profile.socialUrl || "",
	});
	const [savingUsername, setSavingUsername] = useState(false);
	const [savingProfile, setSavingProfile] = useState(false);

	const usernameChanged = !!username.trim() && username !== currentUsername;
	const profileChanged =
		displayName.trim() !== savedProfile.displayName || socialUrl.trim() !== savedProfile.socialUrl;
	const chainAccounts = portfolio?.chains.filter((chain) => chain.account?.status === "active") ?? [];
	const visibleAccounts = chainAccounts.length > 0
		? chainAccounts
		: profile.walletAddress
			? [{
				key: activeNetwork.key,
				name: activeNetwork.name,
				explorerBaseUrl: activeNetwork.explorerBaseUrl,
				account: { walletAddress: profile.walletAddress },
			}]
			: [];

	async function saveUsername() {
		if (!usernameChanged) return;
		setSavingUsername(true);
		const normalized = username.trim().toLowerCase();
		try {
			await notifyPromise(
				apiFetch("/user/username", { user, method: "PUT", body: { username: normalized } }),
				{
					loading: t("settings.saving"),
					success: t("settings.usernameSaved"),
					error: t("settings.saveError"),
				},
			);
			setCurrentUsername(normalized);
			await mutateSWR<HomeReadModel>(
				`${SERVER_URL}/home`,
				(current) => current
					? { ...current, identity: { ...current.identity, username: normalized } }
					: current,
				{ revalidate: false },
			);
		} catch {
			// notifyPromise already surfaced the error.
		} finally {
			setSavingUsername(false);
		}
	}

	async function saveProfile() {
		if (!profileChanged) return;
		setSavingProfile(true);
		try {
			await notifyPromise(
				apiFetch("/user/profile", {
					user,
					method: "PUT",
					body: { displayName: displayName.trim(), socialUrl: socialUrl.trim() },
				}),
				{
					loading: t("settings.saving"),
					success: t("settings.profileSaved"),
					error: t("settings.saveError"),
				},
			);
			const saved = { displayName: displayName.trim(), socialUrl: socialUrl.trim() };
			setSavedProfile(saved);
			await mutateSWR<HomeReadModel>(
				`${SERVER_URL}/home`,
				(current) => current
					? { ...current, identity: { ...current.identity, ...saved } }
					: current,
				{ revalidate: false },
			);
		} catch {
			// notifyPromise already surfaced the error.
		} finally {
			setSavingProfile(false);
		}
	}

	return (
		<div className="animate-fade-up">
					<div className="flex items-center gap-4 mb-7 px-1">
						{user.photoURL ? (
							<img src={user.photoURL} alt="" referrerPolicy="no-referrer" width="64" height="64" className="h-16 w-16 border-2 border-text object-cover shadow-[5px_5px_0_var(--color-cat-700)]" />
						) : (
							<div className="flex h-16 w-16 items-center justify-center border-2 border-text bg-cat-500 font-display text-[22px] text-on-cat shadow-[5px_5px_0_var(--color-cat-700)]">
								{(displayName || user.displayName || user.email || "?")[0].toUpperCase()}
							</div>
						)}
						<div className="min-w-0">
							<p className="font-display text-[21px] truncate">{displayName || user.displayName || t("menu.profile")}</p>
							<p className="text-[13px] text-text-muted truncate">{currentUsername ? `@${currentUsername}` : user.email}</p>
						</div>
					</div>

					<MeliRoom />

					<SettingsSection title={t("menu.profile")} icon={USER_ICON} tone="brand">
						<div className="p-5">
							<p className="text-[13px] text-text-muted mb-3">{t("settings.profileDesc")}</p>
							<label htmlFor="profile-display-name" className="text-[12px] text-text-faint mb-1.5 block">{t("settings.displayNameLabel")}</label>
							<input id="profile-display-name" type="text" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={40} placeholder={t("settings.displayNamePlaceholder")} className="meli-field mb-3 h-12 text-[14px] placeholder:text-text-faint" />
							<label htmlFor="profile-social" className="text-[12px] text-text-faint mb-1.5 block">{t("settings.socialLabel")}</label>
							<input id="profile-social" type="url" inputMode="url" autoComplete="off" value={socialUrl} onChange={(event) => setSocialUrl(event.target.value)} maxLength={120} placeholder={t("settings.socialPlaceholder")} className="meli-field mb-1.5 h-12 text-[14px] placeholder:text-text-faint" />
							<p className="text-[12px] text-text-faint mb-3">{t("settings.socialHint")}</p>
							<button onClick={() => void saveProfile()} disabled={savingProfile || !profileChanged} className="btn btn-primary btn-sm">{savingProfile ? t("settings.saving") : t("settings.save")}</button>
						</div>
					</SettingsSection>

					<SettingsSection title={t("settings.usernameTitle")} icon={USER_ICON} tone="info">
						<div className="p-5">
							<p className="text-[13px] text-text-muted mb-3">{t("settings.usernameDesc")}</p>
							<div className="mb-3 flex h-12 items-center gap-2 border-2 border-text bg-surface px-3.5">
								<span className="text-text-faint text-[14px]">{new URL(APP_URL).host}/</span>
								<input type="text" autoComplete="off" aria-label={t("settings.usernameTitle")} value={username} onChange={(event) => setUsername(event.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase())} maxLength={30} className="flex-1 bg-transparent text-text text-[14px] min-w-0" />
							</div>
							<button onClick={() => void saveUsername()} disabled={savingUsername || !usernameChanged} className="btn btn-primary btn-sm">{savingUsername ? t("settings.saving") : t("settings.save")}</button>
						</div>
					</SettingsSection>

					{visibleAccounts.length > 0 ? (
						<SettingsSection title={t("settings.accountTitle")} icon={WALLET_ICON} tone="neutral">
							{visibleAccounts.map((chain, index) => {
								const address = chain.account!.walletAddress;
								return <div key={chain.key} className={`p-5 ${index > 0 ? "border-t border-border" : ""}`}>
									<div className="flex items-center justify-between gap-3 mb-2">
										<span className="text-[13px] text-text-muted">{t("settings.address")}</span>
										<span className="text-[11px] text-text-faint">{chain.name}</span>
									</div>
									<p className="font-mono text-[12px] text-text break-all mb-4">{address}</p>
									<div className="flex gap-2.5">
										<button onClick={() => void navigator.clipboard.writeText(address).then(() => notifySuccess(t("settings.addressCopied")))} className="btn btn-ghost btn-sm flex-1">{t("common.copy")}</button>
										<a href={`${chain.explorerBaseUrl}/address/${address}`} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm flex-1">{t("settings.viewExplorer")}</a>
									</div>
								</div>;
							})}
						</SettingsSection>
					) : null}
		</div>
	);
}
