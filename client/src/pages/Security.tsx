// Security center (/security): its own destination, not a Settings section.
// Everything about keys and recovery lives here - the on-chain tiles, the
// account-vs-device warning, the add-backup-key flow, the non-custodial
// promise, and plain-words explanations for people who don't know what a
// passkey is. The menu, Settings and the recovery flow all point here.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { User } from "../lib/firebase";
import { apiFetch } from "../lib/api";
import { createPasskey, hasUsableKeyForSigners, signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { hexToBytes } from "../lib/hex";
import { formatDate } from "../lib/format";
import { notifyError, notifySuccess } from "../lib/notify";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import LinkButton from "../components/LinkButton";
import { Spinner } from "../components/icons";

interface PasskeyStatusResponse {
	hasWallet: boolean;
	signerCount: number | null;
	guardian: string | null;
	recoveryPending: boolean | null;
	recoveryExecutableAfter: string | null;
	/** Registered ERC-7913 signer bytes; null while the chain read fails. */
	signers: string[] | null;
}

function isZeroAddress(address: string | null | undefined) {
	return !address || /^0x0{40}$/i.test(address);
}

const CHEVRON = (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0 transition-transform group-open:rotate-90">
		<path d="m9 18 6-6-6-6" />
	</svg>
);

function Faq({ question, children }: { question: string; children: React.ReactNode }) {
	return (
		<details className="group px-0.5">
			<summary className="text-[14px] text-text cursor-pointer list-none flex items-center justify-between gap-3 py-2.5">
				{question}
				{CHEVRON}
			</summary>
			<div className="flex flex-col gap-2 pb-2.5">{children}</div>
		</details>
	);
}

export default function Security({ user }: { user: User }) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<PasskeyStatusResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [updatingPasskey, setUpdatingPasskey] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setStatus(await apiFetch<PasskeyStatusResponse>("/account/passkey", { user }));
		} catch {
			setStatus(null);
		}
	}, [user]);

	useEffect(() => {
		(async () => {
			await refresh();
			setLoading(false);
		})();
	}, [refresh]);

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

			const assertion = await signWithPasskey(hexToBytes(userOpHash), credentialId);
			const submit = await submitUserOp(user, userOpHash, assertion);

			await refresh();
			if (submit.confirmed) {
				notifySuccess(t("settings.keyAdded"), t("settings.keyAddedDesc"));
			} else {
				// Broadcast but unconfirmed: the reconciler settles it in minutes.
				notifySuccess(t("settings.keyPending"), t("settings.keyPendingDesc"));
			}
		} catch (err) {
			notifyError(err, t("settings.keyAddError"));
		} finally {
			setUpdatingPasskey(false);
		}
	}

	const recoveryDateLabel = status?.recoveryExecutableAfter
		? formatDate(status.recoveryExecutableAfter, { day: "numeric", month: "long" })
		: null;
	const keyCount = status?.signerCount || 1;
	const recoveryOn = !isZeroAddress(status?.guardian);
	const deviceMissingKey =
		!!status?.signers &&
		status.signers.length > 0 &&
		!hasUsableKeyForSigners(status.signers) &&
		!status.recoveryPending;

	return (
		<Screen>
			<BackHeader to="/" title={t("menu.security")} />

			{loading ? (
				<div className="flex-1 flex items-center justify-center">
					<Spinner />
				</div>
			) : (
				<div className="animate-fade-up">
					{/* Keys: on-chain truth + this device's reality */}
					<div className="bg-surface border border-border rounded-[20px] p-5 mb-4 shadow-e1">
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

						{/* Account vs device: the tiles above are on-chain truth; this warns
						    when THIS device holds no key of the account. */}
						{deviceMissingKey && (
							<div className="bg-glow-pink/10 border border-glow-pink/20 rounded-[14px] p-3.5 mb-4">
								<p className="text-[13px] text-glow-pink leading-relaxed">
									{t("settings.deviceNoKey")}
								</p>
								<LinkButton
									to="/recover"
									className="text-[13px] text-glow-pink underline underline-offset-2 mt-1.5 inline-block"
								>
									{t("recover.bannerCta")}
								</LinkButton>
							</div>
						)}

						{status?.recoveryPending && (
							<div className="bg-glow-pink/10 border border-glow-pink/20 rounded-[14px] p-3.5 mb-4">
								<p className="text-[13px] text-glow-pink leading-relaxed">
									{t("settings.recoveryPending")}
									{recoveryDateLabel ? t("settings.recoveryAvailableOn", { date: recoveryDateLabel }) : ""}.
								</p>
								{/* The cancel action lives ONLY in /recover: one surface for it. */}
								<LinkButton
									to="/recover"
									className="text-[13px] text-glow-pink underline underline-offset-2 mt-1.5 inline-block"
								>
									{t("recover.settingsView")}
								</LinkButton>
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

					{/* The non-custodial promise + the recovery door */}
					<div className="bg-surface border border-border rounded-[20px] p-5 mb-4 shadow-e1">
						<p className="text-[13px] text-glow-sky leading-relaxed mb-4">
							{t("settings.trustBlock")}
						</p>
						<LinkButton
							to="/recover"
							className="w-full flex items-center justify-between gap-3 bg-surface-2 rounded-[14px] px-3.5 py-3"
						>
							<div>
								<p className="text-[14px] mb-0.5">{t("recover.settingsTitle")}</p>
								<p className="text-[12px] text-text-muted leading-relaxed">
									{t("recover.settingsBody")}
								</p>
							</div>
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0">
								<path d="m9 18 6-6-6-6" />
							</svg>
						</LinkButton>
					</div>

					{/* Plain-words answers (bench §7ter: security explained like to a friend) */}
					<div className="bg-surface border border-border rounded-[20px] px-5 py-2 shadow-e1 divide-y divide-border">
						<Faq question={t("security.whatIsKeyTitle")}>
							<p className="text-[12px] text-text-muted leading-relaxed">
								{t("security.whatIsKeyBody1")}
							</p>
							<p className="text-[12px] text-text-muted leading-relaxed">
								{t("security.whatIsKeyBody2")}
							</p>
						</Faq>
						<Faq question={t("settings.faqLostPhone")}>
							<p className="text-[12px] text-text-muted leading-relaxed">{t("settings.faqBackedUp")}</p>
							<p className="text-[12px] text-text-muted leading-relaxed">{t("settings.faqNoBackup")}</p>
							<p className="text-[12px] text-text-muted leading-relaxed">{t("settings.faqFoundOld")}</p>
						</Faq>
						<Faq question={t("security.faqParmeliaTitle")}>
							<p className="text-[12px] text-text-muted leading-relaxed">
								{t("security.faqParmeliaBody")}
							</p>
						</Faq>
					</div>
				</div>
			)}
		</Screen>
	);
}
