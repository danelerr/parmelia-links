import { useState } from "react";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { type User, logOut } from "../lib/firebase";
import { apiFetch } from "../lib/api";
import { type AccountOperationResponse, waitForAccountOperation } from "../lib/accountOperations";
import { notifyError, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import { createPasskey } from "../lib/webauthn";
import BrandLockup from "../components/brand/BrandLockup";
import MeliSprite from "../components/brand/MeliSprite";
import PixelRail from "../components/brand/PixelRail";
import Turnstile from "../components/Turnstile";
import { useTranslation } from "react-i18next";
import { readMigratedStorage, removeMigratedStorage } from "../lib/storageMigration";

const REF_STORAGE_KEY = "gatopago:ref";
const LEGACY_REF_STORAGE_KEY = "parmelia:ref";

function Reassurance({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-3 text-left">
			<span className="flex h-7 w-7 shrink-0 items-center justify-center border border-growth bg-growth/12 text-growth">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			</span>
			<span className="text-[14px] text-text-muted">{children}</span>
		</div>
	);
}

export default function Onboarding({
	user,
	onComplete,
}: {
	user: User;
	onComplete: () => void;
}) {
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const [creatingWallet, setCreatingWallet] = useState(false);
	// Invite code: prefilled when the user arrived through an invite link.
	const [inviteCode, setInviteCode] = useState(() => {
		try {
			return readMigratedStorage(REF_STORAGE_KEY, LEGACY_REF_STORAGE_KEY) || "";
		} catch {
			return "";
		}
	});
	// Turnstile token. null = not ready yet; "" = not configured (server skips).
	const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

	async function handleCreateWallet() {
		setCreatingWallet(true);
		try {
			if (!user.uid) throw new Error(t("common.sessionExpired"));
			const passkeyLabel = user.email || user.displayName || undefined;
			const { credentialId, qx, qy } = await createPasskey(user.uid, passkeyLabel);

			// Referral attribution: invite link (?ref) or the manually entered code.
			const ref = inviteCode.trim() || undefined;
			const operation = await apiFetch<AccountOperationResponse>("/account/create", {
				user,
				body: { credentialId, qx, qy, ref, turnstileToken },
			});
			await waitForAccountOperation(user, operation);

			removeMigratedStorage(REF_STORAGE_KEY, LEGACY_REF_STORAGE_KEY);
			track("wallet_created", { referred: !!ref });
			notifySuccess(t("onboarding.accountReady"), t("onboarding.welcomeFunds"));
			onComplete();
			navigate("/", { replace: true });
		} catch (err) {
			notifyError(err, t("onboarding.createError"));
		} finally {
			setCreatingWallet(false);
		}
	}

	const firstName = user.displayName ? user.displayName.split(" ")[0] : null;

	return (
		<div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-5">
			<header className="flex justify-center pt-[calc(env(safe-area-inset-top)+1.25rem)]"><BrandLockup compact /></header>
			<div className="flex flex-1 flex-col items-center justify-center py-5 text-center animate-fade-up">
				<MeliSprite name="head-focused" className="mb-4 w-24" priority />
				<div className="mb-5 w-full max-w-[300px]" aria-label={t("onboarding.progressAria")}>
					<div className="grid grid-cols-3 gap-2 text-[10px] font-semibold uppercase tracking-[0.08em]">
						<span className="text-growth">{t("onboarding.stepIdentity")}</span>
						<span className="text-cat-300">{t("onboarding.stepPasskey")}</span>
						<span className="text-text-faint">{t("onboarding.stepReady")}</span>
					</div>
					<PixelRail state="active" className="mt-1" />
				</div>

				<h1 className="font-display text-[28px] leading-tight mb-3">
					{t("onboarding.almostReady")}
					{firstName ? (
						<>
							, <span className="text-cat-300">{firstName}</span>
						</>
					) : null}
				</h1>
				<p className="text-text-muted text-[15px] leading-relaxed max-w-[300px] mb-8">
					{t("onboarding.intro")}
				</p>

				<div className="meli-paper-card meli-paper-card--strong flex w-full max-w-[320px] flex-col gap-3.5 p-5">
					<Reassurance>{t("onboarding.reassure1")}</Reassurance>
					<Reassurance>{t("onboarding.reassure2")}</Reassurance>
					<Reassurance>{t("common.noNetworkFees")}</Reassurance>
				</div>

				{/* Invite code (optional) */}
				<label className="mt-4 block w-full max-w-[320px] text-left text-[12px] text-text-muted">
					<span className="mb-2 block">{t("onboarding.inviteLabel")}</span>
				<div className="flex h-12 items-center gap-2 border-2 border-text bg-surface px-4">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0">
						<path d="M20 12v8H4v-8" />
						<path d="M2 7h20v5H2z" />
						<path d="M12 22V7" />
						<path d="M12 7c-1.5 0-3-1.5-3-3a2 2 0 0 1 4 0c0 1.5-1.5 3-1 3Z" />
					</svg>
					<input
						value={inviteCode}
						onChange={(e) => setInviteCode(e.target.value.toUpperCase().slice(0, 30))}
						placeholder={t("onboarding.invitePlaceholder")}
						className="min-w-0 flex-1 bg-transparent text-center text-[13px] tracking-wide text-text placeholder:text-text-faint"
					/>
				</div>
				</label>
			</div>

			<div
				className="flex flex-col items-center gap-4 animate-fade-up"
				style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
			>
				<Turnstile onToken={setTurnstileToken} />
				<button
					onClick={handleCreateWallet}
					disabled={creatingWallet || turnstileToken === null}
					className="btn btn-primary btn-block"
				>
					{creatingWallet ? t("onboarding.creating") : t("onboarding.createAccount")}
				</button>
				<button
					onClick={logOut}
					className="text-[13px] text-text-faint"
				>
					{t("onboarding.notToday")}
				</button>
			</div>
		</div>
	);
}
