// The canonical API reference lives on the public GatoPago landing -
// single source of truth, indexable and readable before sign-up. The dashboard
// never duplicates it: it deep-links into sections and inlines only the
// contextual snippet next to the data it needs (e.g. signature verification
// beside the webhook secret).

import { DOCS_URL } from "./brand";

export { DOCS_URL };

export function docsUrl(anchor?: string): string {
	return anchor ? `${DOCS_URL}#${anchor}` : DOCS_URL;
}
