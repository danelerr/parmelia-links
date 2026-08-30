import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { ApiError } from "../lib/api";
import { isUserCancelled, notifyWarning } from "../lib/notify";
import { hasRememberedPasskeyHint } from "../lib/webauthn";
import { useViewTransitionNavigate } from "./useNav";
import { securityPathWithReturnTo } from "../lib/safeReturnTo";

const PASSKEY_ACCESS_CODES = new Set([
	"MISSING_PASSKEY_DATA",
	"PASSKEY_NOT_FOUND",
	"PASSKEY_MISMATCH",
]);

const PASSKEY_ACCESS_MESSAGE =
	/passkey not found|passkey no encontrada|no passkeys available|missing qx\/qy/i;

/**
 * Turns an unavailable signing key into one consistent product path.
 *
 * WebAuthn intentionally does not reveal whether NotAllowedError means "the
 * user cancelled" or "this device has no matching credential". If GatoPago has
 * a local hint, callers retain their calm cancellation notice. Without one, we
 * offer Configuracion -> Seguridad without claiming that a synced passkey is
 * definitely absent.
 */
export function usePasskeyGuidance() {
	const { t } = useTranslation();
	const navigate = useViewTransitionNavigate();
	const location = useLocation();

	return useCallback((error: unknown, credentialId?: string | null): boolean => {
		const apiCode = error instanceof ApiError ? error.code : undefined;
		const knownAccessFailure = Boolean(apiCode && PASSKEY_ACCESS_CODES.has(apiCode));
		const messageAccessFailure =
			error instanceof Error && PASSKEY_ACCESS_MESSAGE.test(error.message);
		const unknownCredentialOnThisBrowser =
			isUserCancelled(error) && !hasRememberedPasskeyHint(credentialId);

		if (!knownAccessFailure && !messageAccessFailure && !unknownCredentialOnThisBrowser) {
			return false;
		}

		notifyWarning(
			t("passkeyGuidance.title"),
			t("passkeyGuidance.body"),
			{
				title: t("passkeyGuidance.cta"),
				onClick: () => navigate(securityPathWithReturnTo(
					location.pathname,
					location.search,
					location.hash,
				)),
			},
		);
		return true;
	}, [location.hash, location.pathname, location.search, navigate, t]);
}
