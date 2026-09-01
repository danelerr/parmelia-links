import { useEffect, useState } from "react";
import { mutate as mutateSWR } from "swr";
import type { User } from "../lib/firebase";
import type { HomeReadModel } from "../lib/homeData";
import { SERVER_URL } from "../lib/api";
import { activeNetwork } from "../lib/activeNetwork";
import BrandLockup from "../components/brand/BrandLockup";
import MeliRoom from "../components/brand/MeliRoom";
import ConfirmSheet from "../components/ConfirmSheet";
import AccountLaunchScreen from "../components/AccountLaunchScreen";
import ReceiptModal from "../components/ReceiptModal";
import Home from "./Home";
import CreateLink from "./CreateLink";
import CrosschainSend from "./CrosschainSend";
import Earn from "./Earn";
import Login from "./Login";
import Move from "./Move";
import Onboarding from "./Onboarding";
import PaymentStatus from "./PaymentStatus";
import Profile from "./Profile";
import Receive from "./Receive";
import Security, { type PasskeyStatusResponse } from "./Security";
import Settings from "./Settings";
import StageOverlay from "../components/StageOverlay";
import { usePasskeyGuidance } from "../hooks/usePasskeyGuidance";
import type { ChainPortfolio } from "../hooks/useChainPortfolio";

const previewUser = {
	uid: "meli-preview",
	displayName: "Daniel",
	email: "daniel@example.com",
	photoURL: null,
	getIdToken: async () => "preview-only",
} as unknown as User;

const now = new Date().toISOString();
const previewSecurityStatus: PasskeyStatusResponse = {
	rpId: "app.parmelia.me",
	hasWallet: true,
	chainStatus: "available",
	signerCount: 2,
	threshold: 1,
	guardian: "0x1911911911911911911911911911911911911911",
	recoveryPending: false,
	recoveryExecutableAfter: null,
	signers: null,
	credentialInventoryComplete: true,
	passkeys: [
		{
			credentialId: "preview-primary-key",
			name: "Este teléfono",
			registrationSource: "onboarding",
			transports: ["internal"],
			rpId: "app.parmelia.me",
			aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
			providerName: "Google Password Manager",
			credentialDeviceType: "multiDevice",
			credentialBackedUp: true,
			authenticatorAttachment: "platform",
			metadataUpdatedAt: now,
			createdAt: now,
			lastUsedAt: now,
			currentHint: true,
			activeSigner: true,
		},
		{
			credentialId: "preview-backup-key",
			name: "Llave de respaldo",
			registrationSource: "backup",
			transports: ["internal"],
			rpId: "app.parmelia.me",
			aaguid: null,
			providerName: null,
			credentialDeviceType: "singleDevice",
			credentialBackedUp: false,
			authenticatorAttachment: "cross-platform",
			metadataUpdatedAt: now,
			createdAt: now,
			lastUsedAt: now,
			currentHint: false,
			activeSigner: true,
		},
	],
};
const previewModel: HomeReadModel = {
	schemaVersion: 1,
	identity: { uid: previewUser.uid, username: "daniel", displayName: "Daniel", socialUrl: null },
	account: {
		walletAddress: "0x1911911911911911911911911911911911911911",
		chainId: activeNetwork.chainId,
		chainKey: activeNetwork.key,
		networkName: activeNetwork.name,
	},
	balance: {
		tokens: { USDC: "1248.32", ETH: "0.0834", WBTC: "0" },
		savings: "320.00",
		status: "fresh",
		observedAt: now,
		consistentThroughBlock: "191000000",
		refreshing: false,
		assets: {
			USDC: { value: "1248.32", raw: "1248320000", status: "fresh" },
			ETH: { value: "0.0834", raw: "83400000000000000", status: "fresh" },
		},
	},
	security: { status: "fresh", hasRegisteredPasskey: true },
	activity: {
		status: "fresh",
		source: "ledger",
		sent: [
			{ id: "preview-1", txHash: "0x191", amount: "35", currency: "USDC", to: "0xana", reference: "Diseño del logo", createdAt: now, kind: "payment", counterpartyUsername: "ana", counterpartyDisplayName: "Ana" },
			{ id: "preview-2", txHash: "0x193", amount: "100", currency: "USDC", to: "0xaave", reference: "Mover a Creciendo", createdAt: new Date(Date.now() - 7_200_000).toISOString(), kind: "earn" },
		],
		received: [
			{ id: "preview-3", txHash: "0x192", amount: "80", currency: "USDC", paidBy: "0xlucia", reference: "Proyecto web", createdAt: new Date(Date.now() - 3_600_000).toISOString(), kind: "link", counterpartyUsername: "lucia", counterpartyDisplayName: "Lucía" },
		],
	},
	operations: { status: "fresh", payments: [], account: [] },
	alerts: [],
	stateVersion: "preview",
	observedAt: now,
	consistentThroughBlock: "191000000",
};

const previewPortfolio: ChainPortfolio = {
	chains: [
		{
			key: "arbitrum-sepolia",
			chainId: 421614,
			name: "Arbitrum Sepolia",
			nativeTokenSymbol: "ETH",
			isTestnet: true,
			walletRailEnabled: true,
			swapEnabled: true,
			explorerBaseUrl: "https://sepolia.arbiscan.io",
			faucetUrl: "https://faucet.circle.com",
			rpcConfigured: true,
			account: {
				walletAddress: "0x1911911911911911911911911911911911911911",
				status: "active",
				securityStatus: "current",
				securityVersionApplied: 2,
				securityVersionDesired: 2,
			},
			balance: { assets: [
				{ symbol: "ETH", name: "Ethereum", decimals: 18, isNative: true, value: "0.0834", raw: "83400000000000000", status: "fresh", observedAt: now, blockNumber: "191000000", blockHash: `0x${"11".repeat(32)}` },
				{ symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false, value: "1248.32", raw: "1248320000", status: "fresh", observedAt: now, blockNumber: "191000000", blockHash: `0x${"11".repeat(32)}` },
			] },
		},
		{
			key: "avalanche-fuji",
			chainId: 43113,
			name: "Avalanche Fuji",
			nativeTokenSymbol: "AVAX",
			isTestnet: true,
			walletRailEnabled: true,
			swapEnabled: false,
			explorerBaseUrl: "https://testnet.snowtrace.io",
			faucetUrl: "https://core.app/tools/testnet-faucet/?subnet=c&token=c",
			rpcConfigured: true,
			account: {
				walletAddress: "0x2929292929292929292929292929292929292929",
				status: "active",
				securityStatus: "current",
				securityVersionApplied: 2,
				securityVersionDesired: 2,
			},
			balance: { assets: [
				{ symbol: "AVAX", name: "Avalanche", decimals: 18, isNative: true, value: "3.75", raw: "3750000000000000000", status: "fresh", observedAt: now, blockNumber: "45000000", blockHash: `0x${"22".repeat(32)}` },
				{ symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false, value: "90.50", raw: "90500000", status: "fresh", observedAt: now, blockNumber: "45000000", blockHash: `0x${"22".repeat(32)}` },
			] },
		},
	],
};

const inactiveFujiPreviewPortfolio: ChainPortfolio = {
	chains: previewPortfolio.chains.map((chain) =>
		chain.key === "avalanche-fuji" ? { ...chain, account: null } : chain,
	),
};

function ProfilePreview() {
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let active = true;
		void mutateSWR(`${SERVER_URL}/home`, previewModel, { revalidate: false }).then(() => {
			if (active) setReady(true);
		});
		return () => {
			active = false;
		};
	}, []);

	return ready ? <Profile user={previewUser} /> : <AccountLaunchScreen />;
}

function ReceivePreview() {
	const [ready, setReady] = useState(false);
	const inactiveFuji = new URLSearchParams(window.location.search).get("inactiveFuji") === "1";

	useEffect(() => {
		let active = true;
		void mutateSWR(`${SERVER_URL}/home`, previewModel, { revalidate: false }).then(() => {
			if (active) setReady(true);
		});
		return () => {
			active = false;
		};
	}, []);

	return ready
		? <Receive user={previewUser} previewPortfolio={inactiveFuji ? inactiveFujiPreviewPortfolio : previewPortfolio} />
		: <AccountLaunchScreen />;
}

function PasskeyGuidancePreview() {
	const guideToPasskeys = usePasskeyGuidance();
	return (
		<main className="app-frame mx-auto min-h-dvh w-full max-w-[480px] px-5 py-8">
			<button
				type="button"
				onClick={() => guideToPasskeys(new DOMException("No credential", "NotAllowedError"))}
				className="btn btn-primary"
			>
				Trigger passkey guidance
			</button>
		</main>
	);
}

export default function DesignPreview() {
	const view = new URLSearchParams(window.location.search).get("view");
	if (view === "login") return <Login />;
	if (view === "onboarding") return <Onboarding user={previewUser} onComplete={() => undefined} />;
	if (view === "skeleton") return <AccountLaunchScreen />;
	if (view === "stage") return <StageOverlay label="Preparando tu pago…" />;
	if (view === "security") return <Security user={previewUser} previewStatus={previewSecurityStatus} previewPortfolio={previewPortfolio} />;
	if (view === "settings") return <Settings user={previewUser} />;
	if (view === "passkey-guidance") return <PasskeyGuidancePreview />;
	if (view === "home-no-keys") {
		return (
			<Home
				user={previewUser}
				previewModel={{
					...previewModel,
					security: { status: "fresh", hasRegisteredPasskey: false },
				}}
				previewPortfolio={previewPortfolio}
			/>
		);
	}
	if (view === "security-error") return <Security user={previewUser} previewStatus={null} />;
	if (view === "security-chain-error") {
		return (
			<Security
				user={previewUser}
				previewStatus={{
					...previewSecurityStatus,
					chainStatus: "unavailable",
					signerCount: null,
					threshold: null,
					guardian: null,
				}}
			/>
		);
	}
	if (view === "security-single-key") {
		return (
			<Security
				user={previewUser}
				previewStatus={{
					...previewSecurityStatus,
					signerCount: 1,
					passkeys: previewSecurityStatus.passkeys.slice(0, 1),
				}}
			/>
		);
	}
	if (view === "security-inactive-key") {
		return (
			<Security
				user={previewUser}
				previewStatus={{
					...previewSecurityStatus,
					passkeys: previewSecurityStatus.passkeys.map((passkey, index) => ({
						...passkey,
						activeSigner: index === 0 ? false : passkey.activeSigner,
					})),
				}}
			/>
		);
	}
	if (view === "security-compat") {
		return (
			<Security
				user={previewUser}
				previewStatus={{
					...previewSecurityStatus,
					passkeys: previewSecurityStatus.passkeys.map((passkey) => ({
						...passkey,
						activeSigner: undefined,
					})),
				}}
			/>
		);
	}
	if (view === "charge") return <CreateLink user={previewUser} />;
	if (view === "receive") return <ReceivePreview />;
	if (view === "crosschain-send") return <CrosschainSend user={previewUser} previewPortfolio={previewPortfolio} />;
	if (view === "earn-network-blocked") return <Earn user={previewUser} />;
	if (view === "payment") return <PaymentStatus user={previewUser} />;
	if (view === "profile") return <ProfilePreview />;
	if (view === "receipt") {
		return (
			<main className="app-frame mx-auto min-h-dvh w-full max-w-[480px] px-5 py-8">
				<ReceiptModal
					tx={{
						id: "receipt-preview",
						type: "received",
						txHash: "0x1911911911911911911911911911911911911911911911911911911911911911",
						amount: "80.00",
						currency: "USDC",
						from: "0x1911911911911911911911911911911911911911",
						reference: "Proyecto web",
						createdAt: now,
						kind: "link",
					}}
					onClose={() => undefined}
				/>
			</main>
		);
	}
	if (view === "dialog") {
		return (
			<main className="app-frame mx-auto min-h-dvh w-full max-w-[480px] px-5 py-8">
				<ConfirmSheet
					title="Revisa antes de firmar"
					amountLabel="Vas a enviar"
					amount="35,00"
					unit="USDC"
					confirmLabel="Confirmar envío"
					warning="Solo firmas esta operación. GatoPago no puede mover otros fondos."
					onConfirm={() => undefined}
					onCancel={() => undefined}
				>
					<dl className="mb-5 border border-border text-[12px]">
						<div className="flex justify-between gap-4 border-b border-border p-3"><dt className="text-text-muted">Para</dt><dd className="font-semibold">@ana</dd></div>
						<div className="flex justify-between gap-4 p-3"><dt className="text-text-muted">Red</dt><dd className="font-semibold">Arbitrum Sepolia</dd></div>
					</dl>
				</ConfirmSheet>
			</main>
		);
	}
	if (view === "room") {
		return (
			<main className="app-frame mx-auto min-h-dvh w-full max-w-[480px] px-5 py-8">
				<BrandLockup className="mb-8" />
				<MeliRoom />
			</main>
		);
	}
	if (view === "move") return <Move />;
	return <Home user={previewUser} previewModel={previewModel} previewPortfolio={previewPortfolio} />;
}
