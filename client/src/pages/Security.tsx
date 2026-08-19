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
import { userOperationChallenge, type PreparedUserOperation } from "../lib/eip712";
import { activeNetwork } from "../lib/activeNetwork";
import { formatDate } from "../lib/format";
import { notifyError, notifySuccess } from "../lib/notify";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import LinkButton from "../components/LinkButton";
import { FormPageSkeleton } from "../components/Skeleton";
import MeliSprite from "../components/brand/MeliSprite";

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

export default function Security({ user, previewStatus }: { user: User; previewStatus?: PasskeyStatusResponse }) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<PasskeyStatusResponse | null>(previewStatus ?? null);
	const [loading, setLoading] = useState(!previewStatus);
	const [updatingPasskey, setUpdatingPasskey] = useState(false);

	const refresh = useCallback(async () => {
		if (previewStatus) {
			setStatus(previewStatus);
			return;
		}
		try {
			setStatus(await apiFetch<PasskeyStatusResponse>("/account/passkey", { user }));
		} catch {
			setStatus(null);
		}
	}, [previewStatus, user]);

	useEffect(() => {
		if (previewStatus) return;
		(async () => {
			await refresh();
			setLoading(false);
		})();
	}, [previewStatus, refresh]);

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

			const prepared = await apiFetch<PreparedUserOperation>("/account/passkey/prepare", {
				user,
				body: { callData: intentData.addSignerCalldata },
			});

			const assertion = await signWithPasskey(
				userOperationChallenge(prepared, activeNetwork.chainId),
				prepared.credentialId,
			);
			const submit = await submitUserOp(user, prepared.userOpHash, assertion);

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
			<BackHeader title={t("menu.security")} />

			{loading ? (
				<FormPageSkeleton />
			) : (
				<div className="animate-fade-up">
					<section className="meli-ink-card relative mb-6 min-h-[196px] overflow-hidden p-5" aria-labelledby="security-hero-title">
						<div className="relative z-1 max-w-[270px] pr-10">
							<p className="meli-kicker mb-3 !text-cat-500">{t("security.eyebrow")}</p>
							<h2 id="security-hero-title" className="font-display text-[25px] leading-[1.02] text-[#fff8f0]">
								{t("security.heroTitle")}
							</h2>
							<p className="mt-3 text-[12px] leading-relaxed text-[rgb(255_248_240/.68)]">
								{t("security.heroBody")}
							</p>
							<span className="mt-4 inline-flex items-center gap-2 border border-[rgb(255_248_240/.3)] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-[#fff8f0]">
								<i className="h-2 w-2 bg-growth" aria-hidden="true" />
								{t("security.protected")}
							</span>
						</div>
						<MeliSprite name="head-focused" motion="idle" className="pointer-events-none absolute -bottom-2 -right-3 w-28 opacity-95" />
					</section>

					<section className="meli-paper-card meli-paper-card--strong mb-6 overflow-hidden" aria-labelledby="security-keys-title">
						<div className="flex items-start gap-3 border-b-2 border-text p-5">
							<div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center border-2 border-text bg-cat-500 text-text shadow-[3px_3px_0_var(--color-cat-700)]">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M12 1a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V5a4 4 0 0 0-4-4Z" />
									<circle cx="12" cy="14" r="1.5" fill="currentColor" stroke="none" />
								</svg>
							</div>
							<div className="min-w-0">
								<p id="security-keys-title" className="meli-kicker mb-2">{t("security.accessTitle")}</p>
								<h3 className="font-display text-[18px] leading-tight">
									{t("settings.fingerprintKeyTitle")}
								</h3>
								<p className="text-[13px] text-text-muted leading-relaxed mt-1">
									{t("settings.fingerprintKeyDesc")}
								</p>
							</div>
						</div>

						<div className="grid grid-cols-2 border-b border-text">
							<div className="border-r border-text bg-surface-2 px-4 py-4">
								<p className="type-mono text-[25px] font-bold leading-none text-growth">{keyCount}</p>
								<p className="mt-2 text-[11px] leading-tight text-text-muted">
									{t("settings.keyActive", { count: keyCount })}
								</p>
							</div>
							<div className="bg-surface-2 px-4 py-4">
								<p className="font-display text-[25px] leading-none text-pending">
									{recoveryOn ? t("settings.yes") : "-"}
								</p>
								<p className="mt-2 text-[11px] leading-tight text-text-muted">{t("settings.recovery")}</p>
							</div>
						</div>

						<div className="p-5">
							{deviceMissingKey ? (
							<div className="mb-4 border-2 border-danger bg-danger/10 p-3.5">
								<p className="text-[13px] leading-relaxed text-danger">
									{t("settings.deviceNoKey")}
								</p>
								<LinkButton
									to="/recover"
									className="mt-1.5 inline-block text-[13px] text-danger underline underline-offset-2"
								>
									{t("recover.bannerCta")}
								</LinkButton>
							</div>
							) : null}

							{status?.recoveryPending ? (
							<div className="mb-4 border-2 border-pending bg-pending/10 p-3.5">
								<p className="text-[13px] leading-relaxed text-pending">
									{t("settings.recoveryPending")}
									{recoveryDateLabel ? t("settings.recoveryAvailableOn", { date: recoveryDateLabel }) : ""}.
								</p>
								{/* The cancel action lives ONLY in /recover: one surface for it. */}
								<LinkButton
									to="/recover"
									className="mt-1.5 inline-block text-[13px] text-pending underline underline-offset-2"
								>
									{t("recover.settingsView")}
								</LinkButton>
							</div>
							) : null}

							<button
								onClick={handleAddPasskey}
								disabled={updatingPasskey}
								className="btn btn-primary btn-block"
							>
								{updatingPasskey ? t("settings.addingKey") : t("settings.addBackupKey")}
							</button>
							<p className="text-[12px] text-text-faint leading-relaxed mt-3 px-0.5">
								{t("settings.addBackupKeyDesc")}
							</p>
						</div>
					</section>

					<LinkButton to="/recover" className="meli-path-card-app interactive-surface mb-6 min-h-[104px] p-4 text-left">
						<span aria-hidden="true">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
							</svg>
						</span>
						<span className="min-w-0">
							<strong className="block font-display text-[17px]">{t("security.recoveryTitle")}</strong>
							<small className="mt-1 block text-[11px] leading-relaxed text-text-muted">{t("recover.settingsBody")}</small>
							<small className="mt-2 block font-mono text-[9px] uppercase tracking-[0.06em] text-cat-700">
								{recoveryOn ? t("security.recoveryReady") : t("security.recoverySetup")}
							</small>
						</span>
						<span aria-hidden="true" className="font-mono text-[18px] font-bold">→</span>
					</LinkButton>

					<div className="meli-paper-card mb-6 grid grid-cols-[36px_1fr] gap-3 border-l-4 !border-l-info p-4">
						<div className="flex h-9 w-9 items-center justify-center border border-info bg-info/10 text-info" aria-hidden="true">✦</div>
						<div>
							<p className="font-display text-[14px]">{t("security.selfCustodyTitle")}</p>
							<p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t("settings.trustBlock")}</p>
						</div>
					</div>

					<section aria-labelledby="security-learn-title">
						<p id="security-learn-title" className="meli-kicker mb-3 px-1">{t("security.learnTitle")}</p>
						<div className="meli-paper-card meli-paper-card--strong divide-y divide-border px-5 py-2">
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
						<Faq question={t("security.faqGatoPagoTitle")}>
							<p className="text-[12px] text-text-muted leading-relaxed">
								{t("security.faqGatoPagoBody")}
							</p>
						</Faq>
						</div>
					</section>
				</div>
			)}
		</Screen>
	);
}
