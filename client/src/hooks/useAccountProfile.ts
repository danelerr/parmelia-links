import { useMemo } from "react";
import useSWR from "swr";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import type { HomeReadModel } from "../lib/homeData";

export type AccountProfile = {
	username: string | null;
	walletAddress: string | null;
	displayName: string | null;
	socialUrl: string | null;
};

export function useAccountProfile(user: User) {
	// App seeds this canonical key before opening a protected route. Reading it
	// without a fetcher lets secondary screens reuse the account bootstrap rather
	// than issuing their own blocking /user/profile request.
	const home = useSWR<HomeReadModel>(`${SERVER_URL}/home`, null, {
		revalidateOnMount: false,
	});

	const fallback = useSWR<AccountProfile>(
		home.data ? null : `${SERVER_URL}/user/profile`,
		async (url: string) => {
			const response = await fetchWithAuth(user, url);
			if (!response.ok) throw new Error("Profile API error");
			const data = await response.json();
			return {
				username: data.username ?? null,
				walletAddress: data.walletAddress ?? null,
				displayName: data.displayName ?? null,
				socialUrl: data.socialUrl ?? null,
			};
		},
		{ revalidateOnFocus: false, dedupingInterval: 30_000 },
	);

	const hasHomeProfile = home.data !== undefined;
	const homeUsername = home.data?.identity.username ?? null;
	const homeWalletAddress = home.data?.account.walletAddress ?? null;
	const homeDisplayName = home.data?.identity.displayName ?? null;
	const homeSocialUrl = home.data?.identity.socialUrl ?? null;
	const profile = useMemo<AccountProfile | undefined>(
		() =>
			hasHomeProfile
				? {
						username: homeUsername,
						walletAddress: homeWalletAddress,
						displayName: homeDisplayName,
						socialUrl: homeSocialUrl,
					}
				: fallback.data,
		[
			fallback.data,
			hasHomeProfile,
			homeDisplayName,
			homeSocialUrl,
			homeUsername,
			homeWalletAddress,
		],
	);

	return {
		profile,
		loading: !profile && fallback.isLoading,
		error: fallback.error,
	};
}
