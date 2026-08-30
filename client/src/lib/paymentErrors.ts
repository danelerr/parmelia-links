import type { TFunction } from "i18next";
import { activeNetwork } from "./activeNetwork";
import { APP_URL } from "./brand";

const PAYMENT_APP_HOST = new URL(APP_URL).hostname;

/** Translate known ERC-4337, WebAuthn and balance errors; bound unknown text. */
export function parsePaymentError(message: string, t: TFunction): string {
	if (message.includes("AA24")) return t("pay.errPasskeyValidate");
	if (message.includes("AA21")) return t("pay.errInsufficient");
	if (message.includes("AA25")) return t("pay.errSignatureInvalid");
	if (message.includes("Missing qx/qy")) return t("pay.errPasskeyDevice");
	if (
		message.includes("Saldo USDC insuficiente") ||
		message.includes(`Saldo ${activeNetwork.nativeTokenSymbol} insuficiente`) ||
		message.includes("Saldo ETH insuficiente") ||
		message.toLowerCase().includes("insufficient")
	) {
		return t("pay.errInsufficient");
	}
	if (message.includes("Passkey not found") || message.includes("Passkey no encontrada")) {
		return t("pay.errPasskeyNotFound");
	}
	if (message.includes("No passkeys available")) {
		return t("pay.errNoPasskeys", { host: PAYMENT_APP_HOST });
	}
	if (
		message.includes("NotAllowedError") ||
		message.includes("timed out or was not allowed") ||
		message.includes("Firma cancelada")
	) {
		return t("pay.errCancelled");
	}
	if (message.includes("FailedOp")) {
		const match = message.match(/FailedOp\([^,]+,\s*"?([^")]+)/);
		if (match) return `Error: ${match[1]}`;
	}
	return message.length > 150 ? t("pay.errGeneric") : message;
}
