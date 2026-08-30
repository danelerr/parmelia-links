function hasUnsafePathCharacter(value: string): boolean {
	return value.includes("\\") || [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

export function safeReturnTo(value: string | null | undefined): string | null {
	if (!value || !value.startsWith("/") || value.startsWith("//") || hasUnsafePathCharacter(value)) {
		return null;
	}
	try {
		const url = new URL(value, window.location.origin);
		if (url.origin !== window.location.origin) return null;
		const decodedPath = decodeURIComponent(url.pathname);
		if (decodedPath.startsWith("//") || hasUnsafePathCharacter(decodedPath)) return null;
		const destination = `${url.pathname}${url.search}${url.hash}`;
		if (url.pathname === "/settings/security") return null;
		return destination;
	} catch {
		return null;
	}
}

export function securityPathWithReturnTo(pathname: string, search: string, hash: string): string {
	const returnTo = safeReturnTo(`${pathname}${search}${hash}`);
	return returnTo
		? `/settings/security?returnTo=${encodeURIComponent(returnTo)}`
		: "/settings/security";
}
