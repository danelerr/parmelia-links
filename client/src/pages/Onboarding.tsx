import { useState } from "react";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { type User, logOut } from "../lib/firebase";
import { apiFetch } from "../lib/api";
import { type AccountOperationResponse, waitForAccountOperation } from "../lib/accountOperations";
import { notifyError, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import { createPasskey } from "../lib/webauthn";
import Logo from "../components/Logo";
import Turnstile from "../components/Turnstile";
import { useTranslation } from "react-i18next";

function Reassurance({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-3 text-left">
			<span className="w-7 h-7 rounded-full bg-sky/15 flex items-center justify-center shrink-0">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
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
	const [inviteCode, setInviteCode] = useState(
		() => localStorage.getItem("parmelia:ref") || "",
	);
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

			localStorage.removeItem("parmelia:ref");
			track("wallet_created", { referred: !!ref });
			notifySuccess(t("onboarding.accountReady"), t("onboarding.welcomeFunds"));
			onComplete();
			navigate("/");
		} catch (err) {
			notifyError(err, t("onboarding.createError"));
		} finally {
			setCreatingWallet(false);
		}
	}

	const firstName = user.displayName ? user.displayName.split(" ")[0] : null;

	return (
		<div className="flex flex-col min-h-dvh px-6 w-full max-w-[460px] mx-auto">
			<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
				<Logo className="w-20 mb-8 animate-float-glow" />

				<h1 className="font-display text-[28px] leading-tight mb-3">
					{t("onboarding.almostReady")}
					{firstName ? (
						<>
							, <span className="text-brand-gradient">{firstName}</span>
						</>
					) : null}
				</h1>
				<p className="text-text-muted text-[15px] leading-relaxed max-w-[300px] mb-8">
					{t("onboarding.intro")}
				</p>

				<div className="w-full max-w-[300px] bg-surface border border-border rounded-[18px] p-5 flex flex-col gap-3.5 shadow-e1">
					<Reassurance>{t("onboarding.reassure1")}</Reassurance>
					<Reassurance>{t("onboarding.reassure2")}</Reassurance>
					<Reassurance>{t("common.noNetworkFees")}</Reassurance>
				</div>

				{/* Invite code (optional) */}
				<div className="w-full max-w-[300px] mt-4 flex items-center gap-2 bg-surface border border-border rounded-full h-11 px-4 focus-within:border-border-strong transition-colors">
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
						className="flex-1 bg-transparent text-[13px] text-text placeholder:text-text-faint tracking-wide min-w-0 text-center"
					/>
				</div>
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
					className="text-[13px] text-text-faint hover:text-text-muted transition-colors"
				>
					{t("onboarding.notToday")}
				</button>
			</div>
		</div>
	);
}
