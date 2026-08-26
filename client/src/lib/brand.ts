const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

/**
 * Operational endpoints still fall back to the pre-cutover hosts. The public
 * VITE_* values are the single switch once GatoPago domains are available.
 */
export const APP_URL = withoutTrailingSlash(
	import.meta.env.VITE_APP_URL || "https://app.parmelia.me",
);

export const SERVER_URL = withoutTrailingSlash(
	import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev",
);

export const PAYMENTS_URL = withoutTrailingSlash(
	import.meta.env.VITE_PAYMENTS_API_URL || import.meta.env.VITE_SERVER_URL || "https://gatopago-payments-api.parmelia.workers.dev",
);
