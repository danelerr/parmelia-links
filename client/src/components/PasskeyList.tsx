import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import { formatDateTime } from "../lib/format";

export type ManagedPasskey = {
	credentialId: string;
	name: string | null;
	registrationSource: "onboarding" | "backup" | "recovery" | "observed" | "unknown";
	transports: string[];
	createdAt: string;
	lastUsedAt: string;
	currentHint: boolean;
};

export default function PasskeyList({
	passkeys,
	signerCount,
	threshold,
	chainAvailable,
	verificationUnavailable,
	busyId,
	onRename,
	onRemove,
}: {
	passkeys: ManagedPasskey[];
	signerCount: number | null;
	threshold: number | null;
	chainAvailable: boolean;
	verificationUnavailable: boolean;
	busyId: string | null;
	onRename: (credentialId: string, name: string) => Promise<boolean>;
	onRemove: (credentialId: string) => Promise<boolean>;
}) {
	const { t } = useTranslation();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draftName, setDraftName] = useState("");
	const [renameErrorId, setRenameErrorId] = useState<string | null>(null);
	const [removeKey, setRemoveKey] = useState<ManagedPasskey | null>(null);
	const [removeFailed, setRemoveFailed] = useState(false);
	const unknownSignerCount = chainAvailable && signerCount !== null
		? Math.max(0, signerCount - passkeys.length)
		: 0;
	const canRemove =
		chainAvailable &&
		signerCount !== null &&
		threshold !== null &&
		signerCount > 1 &&
		signerCount - 1 >= threshold;
	const removeBlockedReason = !chainAvailable
		? null
		: signerCount === null || threshold === null
			? t("security.removeBlockedUnverified")
			: signerCount <= 1
				? t("security.removeBlockedLastKey")
				: signerCount - 1 < threshold
					? t("security.removeBlockedThreshold", { threshold })
					: null;
	const removeDescriptionId = verificationUnavailable
		? "passkey-chain-unavailable"
		: removeBlockedReason
			? "passkey-remove-blocked-reason"
			: undefined;

	async function submitRename(credentialId: string) {
		setRenameErrorId(null);
		const renamed = await onRename(credentialId, draftName.trim());
		if (renamed) setEditingId(null);
		else setRenameErrorId(credentialId);
	}

	async function confirmRemove() {
		if (!removeKey) return;
		setRemoveFailed(false);
		const removed = await onRemove(removeKey.credentialId);
		if (removed) setRemoveKey(null);
		else setRemoveFailed(true);
	}

	return (
		<div className="border-t border-border">
			<div className="px-5 pb-2 pt-5">
				<h4 className="font-display text-[16px]">{t("security.keysListTitle")}</h4>
				<p className="mt-1 text-[11px] leading-relaxed text-text-muted">
					{t("security.keysListBody")}
				</p>
			</div>

			{verificationUnavailable ? (
				<p id="passkey-chain-unavailable" className="mx-5 my-3 border-l-4 border-pending bg-pending/10 px-3 py-2 text-[12px] leading-relaxed text-pending">
					{t("security.keysChainUnavailable")}
				</p>
			) : null}

			{!verificationUnavailable && passkeys.length === 0 ? (
				<p className="mx-5 my-4 border-l-4 border-info bg-info/8 px-3 py-2 text-[12px] leading-relaxed text-info">
					{t("security.keysEmpty")}
				</p>
			) : null}

			<div className="divide-y divide-border">
				{passkeys.map((passkey, index) => {
					const editing = editingId === passkey.credentialId;
					const fallbackName = t("security.keyFallbackName", { number: index + 1 });
					const renameError = renameErrorId === passkey.credentialId;
					const renameErrorDomId = `passkey-name-error-${index}`;
					return (
						<div key={passkey.credentialId} className="px-5 py-4">
							{editing ? (
								<form
									onSubmit={(event) => {
										event.preventDefault();
										void submitRename(passkey.credentialId);
									}}
									className="grid grid-cols-2 gap-2"
									aria-busy={busyId === passkey.credentialId}
								>
									<label className="col-span-2 min-w-0 text-[11px] text-text-muted">
										<span className="mb-1 block">{t("security.keyNameLabel")}</span>
										<input
											name="passkey-name"
											value={draftName}
											onChange={(event) => setDraftName(event.target.value)}
											className="meli-field h-10 text-[13px]"
											autoComplete="off"
											autoFocus
											maxLength={64}
											disabled={busyId === passkey.credentialId}
											aria-invalid={renameError}
											aria-describedby={renameError ? renameErrorDomId : undefined}
											required
										/>
									</label>
									<button type="submit" disabled={!draftName.trim() || busyId === passkey.credentialId} className="btn btn-primary h-10 px-3 text-[12px]">
										{t("common.save")}
									</button>
									<button type="button" disabled={busyId === passkey.credentialId} onClick={() => setEditingId(null)} className="btn-text h-10 px-2 text-[12px]">
										{t("common.cancel")}
									</button>
									{renameError ? (
										<p id={renameErrorDomId} className="col-span-2 text-[11px] leading-relaxed text-danger" role="alert">
											{t("security.keyRenameRetry")}
										</p>
									) : null}
								</form>
							) : (
								<>
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<p className="truncate text-[14px] font-semibold text-text">{passkey.name || fallbackName}</p>
											<p className="mt-1 font-mono text-[9px] uppercase tracking-[0.06em] text-text-faint">
												{t(`security.keySource.${passkey.registrationSource}`)}
												{passkey.currentHint ? ` · ${t("security.keyRecentHint")}` : ""}
											</p>
										</div>
										<div className="flex shrink-0 gap-3">
											<button
												type="button"
												onClick={() => {
													setDraftName(passkey.name || fallbackName);
													setRenameErrorId(null);
													setEditingId(passkey.credentialId);
												}}
												disabled={busyId !== null}
												className="min-h-11 px-1 text-[12px] text-cat-700 underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
											>
												{t("common.edit")}
											</button>
											<button
												type="button"
												disabled={!canRemove || busyId !== null}
												onClick={() => {
													setRemoveFailed(false);
													setRemoveKey(passkey);
												}}
												aria-describedby={!canRemove ? removeDescriptionId : undefined}
												className="min-h-11 px-1 text-[12px] text-danger underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
											>
												{t("security.removeKey")}
											</button>
										</div>
									</div>
									<p className="mt-2 text-[10px] text-text-faint">
										{t("security.keyLastUsed", { date: formatDateTime(passkey.lastUsedAt) })}
									</p>
								</>
							)}
						</div>
					);
				})}
			</div>

			{passkeys.length > 0 && removeBlockedReason ? (
				<p id="passkey-remove-blocked-reason" className="mx-5 mb-4 border-l-4 border-pending bg-pending/10 px-3 py-2 text-[11px] leading-relaxed text-pending">
					{removeBlockedReason}
				</p>
			) : null}

			{unknownSignerCount > 0 ? (
				<p className="mx-5 mb-4 border-l-4 border-info bg-info/8 px-3 py-2 text-[11px] leading-relaxed text-info">
					{t("security.unknownKeys", { count: unknownSignerCount })}
				</p>
			) : null}

			{removeKey ? (
				<RemoveKeyDialog
					name={removeKey.name || t("security.keyFallbackName", { number: 1 })}
					busy={busyId === removeKey.credentialId}
					failed={removeFailed}
					onCancel={() => setRemoveKey(null)}
					onConfirm={() => void confirmRemove()}
				/>
			) : null}
		</div>
	);
}

function RemoveKeyDialog({
	name,
	busy,
	failed,
	onCancel,
	onConfirm,
}: {
	name: string;
	busy: boolean;
	failed: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation();
	const requestClose = () => {
		if (!busy) onCancel();
	};
	const dialogRef = useDialog<HTMLDivElement>(requestClose);
	return createPortal(
		<div className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center px-5" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }} onClick={requestClose}>
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="remove-key-title" aria-describedby={`remove-key-body remove-key-warning${failed ? " remove-key-error" : ""}`} tabIndex={-1} className="dialog-panel w-full max-w-sm p-6 animate-sheet-up" onClick={(event) => event.stopPropagation()}>
				<div className="sheet-handle mb-5" aria-hidden="true" />
				<h2 id="remove-key-title" className="font-display text-[22px]">{t("security.removeKeyTitle")}</h2>
				<p id="remove-key-body" className="mt-3 text-[13px] leading-relaxed text-text-muted">{t("security.removeKeyBody", { name })}</p>
				<p id="remove-key-warning" className="mt-4 border-l-4 border-danger bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">{t("security.removeKeyWarning")}</p>
				{failed ? (
					<p id="remove-key-error" className="mt-3 text-[12px] leading-relaxed text-danger" role="alert">
						{t("security.keyRemoveRetry")}
					</p>
				) : null}
				<button type="button" disabled={busy} onClick={onConfirm} className="btn btn-block mt-5 border-danger bg-danger text-white">
					{busy ? t("security.removingKey") : t("security.removeKeyConfirm")}
				</button>
				<button type="button" disabled={busy} onClick={onCancel} className="btn-text mt-1 w-full">{t("common.cancel")}</button>
			</div>
		</div>,
		document.body,
	);
}
