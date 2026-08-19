import { useState } from "react";
import { useTranslation } from "react-i18next";
import { keccak256 } from "viem";
import type { UserOperationSigningPayload } from "../lib/eip712";

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="py-2.5 border-b border-border last:border-0">
			<span className="text-[11px] text-text-faint block mb-1">{label}</span>
			<span className={`text-[12px] text-text break-all ${mono ? "font-mono" : ""}`}>{value}</span>
		</div>
	);
}

export default function SigningDetails({
	payload,
	networkName,
}: {
	payload: UserOperationSigningPayload;
	networkName: string;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);

	return (
		<div className="mb-4">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="interactive-surface flex h-11 w-full items-center justify-between gap-3 border border-border bg-surface px-3.5 text-left"
			>
				<span className="flex items-center gap-2.5 min-w-0">
					<span className="flex h-7 w-7 shrink-0 items-center justify-center border border-cat-300 bg-cat-500/12 text-cat-300" aria-hidden="true">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
						</svg>
					</span>
					<span className="text-[13px] text-text-muted truncate">
						{open ? t("signing.hideDetails") : t("signing.showDetails")}
					</span>
				</span>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className={`text-text-faint shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
					aria-hidden="true"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</button>

			{open ? (
				<div className="mt-2 border border-border bg-surface px-3.5 animate-fade-in">
					<p className="pb-1 pt-3 text-[11px] leading-relaxed text-cat-300">
						{t("signing.verifiedDescription")}
					</p>
					<Row label={t("signing.standard")} value="EIP-712 · ERC-4337" />
					<Row label={t("signing.network")} value={`${networkName} · ${payload.domain.chainId}`} />
					<Row label={t("signing.account")} value={payload.message.sender} mono />
					<Row label={t("signing.nonce")} value={payload.message.nonce} mono />
					<Row label={t("signing.verifier")} value={payload.domain.verifyingContract} mono />
					<Row label={t("signing.callDataHash")} value={keccak256(payload.message.callData)} mono />
					<Row label={t("signing.digest")} value={payload.digest} mono />
				</div>
			) : null}
		</div>
	);
}
