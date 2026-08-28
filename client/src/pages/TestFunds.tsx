import { useEffect, useState } from "react";
import type { User } from "../lib/firebase";
import { ApiError, SERVER_URL, apiFetch } from "../lib/api";
import { type AccountOperationResponse, waitForAccountOperation } from "../lib/accountOperations";
import { fetchWithAuth } from "../lib/authFetch";
import { notifyError, notifySuccess, notifyWarning } from "../lib/notify";
import { activeNetwork } from "../lib/activeNetwork";
import { useTranslation } from "react-i18next";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import Turnstile from "../components/Turnstile";
import { isTurnstileReady, type TurnstileState } from "../components/turnstileState";
import NoticeCard from "../components/NoticeCard";
import { DetailPageSkeleton } from "../components/Skeleton";
import MeliSprite from "../components/brand/MeliSprite";
import PixelRail from "../components/brand/PixelRail";

async function fetchFaucetStatus(user: User): Promise<{ funded: boolean }> {
	const response = await fetchWithAuth(user, `${SERVER_URL}/account/fund`);
	if (!response.ok) throw new Error("Faucet status request failed");
	return response.json() as Promise<{ funded: boolean }>;
}

export default function TestFunds({ user }: { user: User }) {
	const { t } = useTranslation();
	const [funded, setFunded] = useState<boolean | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [claiming, setClaiming] = useState(false);
	const [turnstile, setTurnstile] = useState<TurnstileState>({
		status: "loading",
		token: null,
	});
	const [challengeRevision, setChallengeRevision] = useState(0);

	useEffect(() => {
		let cancelled = false;
		void fetchFaucetStatus(user)
			.then((result) => {
				if (!cancelled) setFunded(result.funded);
			})
			.catch(() => {
				if (!cancelled) setLoadFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [user]);

	async function claim() {
		if (!isTurnstileReady(turnstile)) return;
		setClaiming(true);
		try {
			const operation = await apiFetch<AccountOperationResponse>("/account/fund", {
				user,
				method: "POST",
				body: { turnstileToken: turnstile.token },
			});
			await waitForAccountOperation(user, operation);
			setFunded(true);
			notifySuccess(t("settings.faucetDoneTitle"), t("settings.faucetDoneDesc"));
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) {
				setFunded(true);
				notifyWarning(t("settings.faucetAlready"));
				return;
			}
			notifyError(error, t("settings.faucetError"));
			setTurnstile({ status: "loading", token: null });
			setChallengeRevision((value) => value + 1);
		} finally {
			setClaiming(false);
		}
	}

	return (
		<Screen>
			<BackHeader title={t("settings.testFunds")} />

			{funded === null && !loadFailed ? (
				<DetailPageSkeleton />
			) : loadFailed ? (
				<NoticeCard tone="warning" title={t("settings.faucetError")}>
					{t("common.tryAgain")}
				</NoticeCard>
			) : funded ? (
				<div className="meli-paper-card meli-paper-card--strong p-5">
					<MeliSprite name="head-happy" motion="purr" className="mx-auto mb-3 w-20" />
					<p className="text-[14px] text-text-muted leading-relaxed mb-4">
						{t("settings.faucetClaimedDesc")}
						{activeNetwork.faucetUrl ? t("settings.faucetNeedMore") : ""}
					</p>
					{activeNetwork.faucetUrl ? (
						<a
							href={activeNetwork.faucetUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="btn btn-ghost btn-block"
						>
							{t("settings.openFaucet", { label: activeNetwork.faucetLabel })}
						</a>
					) : null}
				</div>
			) : (
				<div className="meli-paper-card meli-paper-card--strong p-5">
					<MeliSprite name="body-conveyor" motion={claiming ? "none" : "idle"} className="mx-auto mb-2 w-40" />
					<PixelRail state={claiming ? "active" : "future"} className="mb-4" />
					<p className="text-[14px] text-text-muted leading-relaxed mb-4">
						{t("settings.faucetIntro")}
					</p>
					<div className="mb-4">
						<Turnstile key={challengeRevision} action="test_funds" onStateChange={setTurnstile} />
					</div>
					<button
						type="button"
						onClick={() => void claim()}
						disabled={claiming || !isTurnstileReady(turnstile)}
						className="btn btn-primary btn-block"
					>
						{claiming ? t("settings.sending") : t("settings.getTestFunds")}
					</button>
				</div>
			)}
		</Screen>
	);
}
