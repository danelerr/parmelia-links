// Wallet address as QR + copy row, shared by every "show my address" surface.
// The card frame (bg-surface container) stays at the call site; this is the
// QR-and-copy interior so screens can compose their own titles/warnings.

import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { notifySuccess } from "../lib/notify";

function shortAddr(a: string) {
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function AddressQRCard({
	address,
	qrSize = 188,
	label,
}: {
	address: string;
	qrSize?: number;
	label?: string;
}) {
	const { t } = useTranslation();

	function copy() {
		navigator.clipboard.writeText(address).then(() => notifySuccess(t("receive.addressCopied")));
	}

	return (
		<>
			{label && <p className="text-[13px] text-text-muted mb-4 text-center">{label}</p>}
			<div className="flex justify-center mb-5" role="img" aria-label={label ?? t("home.yourAddress")}>
				<div className="border-2 border-text bg-white p-3 shadow-[6px_6px_0_var(--color-cat-700)]">
					<QRCodeSVG value={address} size={qrSize} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
				</div>
			</div>
			<button
				onClick={copy}
				className="interactive-surface flex w-full items-center justify-between gap-2 border-2 border-text bg-surface px-4 py-3 shadow-[4px_4px_0_var(--color-border)]"
			>
				<span className="font-mono text-[13px] text-text truncate">{shortAddr(address)}</span>
				<span className="shrink-0 text-[12px] font-semibold text-cat-300">{t("receive.copyAddress")}</span>
			</button>
		</>
	);
}
