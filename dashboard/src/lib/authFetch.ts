import type { User } from "./firebase";

function buildAuthHeaders(headers: HeadersInit | undefined, token: string) {
  const nextHeaders = new Headers(headers);
  nextHeaders.set("Authorization", `Bearer ${token}`);
  return nextHeaders;
}

export async function fetchWithAuth(user: User, input: RequestInfo | URL, init?: RequestInit) {
  let token = await user.getIdToken();
  const response = await fetch(input, { ...init, headers: buildAuthHeaders(init?.headers, token) });
  if (response.status !== 401) return response;
  // Token may have just expired — force-refresh once and retry.
  token = await user.getIdToken(true);
  return fetch(input, { ...init, headers: buildAuthHeaders(init?.headers, token) });
}
