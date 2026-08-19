const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const SERVER_URL = withoutTrailingSlash(
	import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev",
);
export const DOCS_URL = `${withoutTrailingSlash(
	import.meta.env.VITE_SITE_URL || "https://parmelia.me",
)}/docs`;
