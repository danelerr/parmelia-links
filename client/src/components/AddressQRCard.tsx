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
			<div className="flex justify-center mb-5">
				<div className="p-3 bg-white rounded-2xl">
					<QRCodeSVG value={address} size={qrSize} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
				</div>
			</div>
			<button
				onClick={copy}
				className="w-full flex items-center justify-between gap-2 bg-surface-2 border border-border rounded-[14px] px-4 py-3 hover:border-border-strong transition-colors"
			>
				<span className="font-mono text-[13px] text-text truncate">{shortAddr(address)}</span>
				<span className="text-[12px] text-glow-sky shrink-0">{t("receive.copyAddress")}</span>
			</button>
		</>
	);
}
