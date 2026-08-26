const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const APP_API_URL = withoutTrailingSlash(
	import.meta.env.VITE_APP_API_URL || import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev",
);

const PAYMENTS_API_URL = withoutTrailingSlash(
	import.meta.env.VITE_PAYMENTS_API_URL || import.meta.env.VITE_SERVER_URL || "https://gatopago-payments-api.parmelia.workers.dev",
);

// Compatibility export for existing dashboard views. The dashboard is a
// Payments client; authentication-only calls use APP_API_URL explicitly.
export const SERVER_URL = PAYMENTS_API_URL;
export const DOCS_URL = `${withoutTrailingSlash(
	import.meta.env.VITE_SITE_URL || "https://parmelia.me",
)}/docs`;
