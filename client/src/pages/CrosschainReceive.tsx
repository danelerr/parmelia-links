// Public cross-chain checkout (Flow A inbound): an EXTERNAL wallet pays a GatoPago
// user from another CCTP chain. No GatoPago account needed. The payer connects
// their own wallet (window.ethereum), and signs the approve + depositForBurn that
// the backend pre-encoded. GatoPago's relayer then mints native USDC on Arbitrum
// to the recipient. Reached at /cc/:recipient (a username or 0x address).

import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { SERVER_URL } from "../lib/api";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../lib/format";
import { activeNetwork } from "../lib/activeNetwork";
import Logo from "../components/Logo";
import AmountInput from "../components/AmountInput";
import TxResult from "../components/TxResult";
import NetworkChips from "../components/NetworkChips";
import Screen from "../components/Screen";
import { FormPageSkeleton } from "../components/Skeleton";
import ConfirmSheet from "../components/ConfirmSheet";
import NoticeCard from "../components/NoticeCard";
import {
	InsetPanel,
	MoneyPanel,
	SectionLabel,
	SummaryRow,
	TransactionActions,
} from "../components/finance/FinancialPrimitives";

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
function getEthereum(): Eip1193 | null {
	return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

type Source = { chainId: number; name: string; domain: number };
type Mode = "fast" | "standard";
type Tx = { to: string; data: string };
type Prepared = {
	opId: string;
	sourceChainId: number;
	approveTx: Tx;
	burnTx: Tx;
	summary: { recipientName: string | null; amountIn: string; amountOutEstimated: string; mode: Mode; estimatedMinutes: number };
};

// add-chain params for known source chains (used only if the wallet lacks the chain).
const CHAIN_PARAMS: Record<number, Record<string, unknown>> = {
	84532: {
		chainId: "0x14a34",
		chainName: "Base Sepolia",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://sepolia.base.org"],
		blockExplorerUrls: ["https://sepolia.basescan.org"],
	},
	421614: {
		chainId: "0x66eee",
		chainName: "Arbitrum Sepolia",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
		blockExplorerUrls: ["https://sepolia.arbiscan.io"],
	},
	42161: {
		chainId: "0xa4b1",
		chainName: "Arbitrum One",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://arb1.arbitrum.io/rpc"],
		blockExplorerUrls: ["https://arbiscan.io"],
	},
	8453: {
		chainId: "0x2105",
		chainName: "Base",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://mainnet.base.org"],
		blockExplorerUrls: ["https://basescan.org"],
	},
	11155111: {
		chainId: "0xaa36a7",
		chainName: "Ethereum Sepolia",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
		blockExplorerUrls: ["https://sepolia.etherscan.io"],
	},
	43113: {
		chainId: "0xa869",
		chainName: "Avalanche Fuji",
		nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
		rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
		blockExplorerUrls: ["https://testnet.snowtrace.io"],
	},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureChain(eth: Eip1193, chainId: number) {
	const hex = "0x" + chainId.toString(16);
	try {
		await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
	} catch (e) {
		const code = (e as { code?: number }).code;
		if (code === 4902 && CHAIN_PARAMS[chainId]) {
			await eth.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS[chainId]] });
		} else {
			throw e;
		}
	}
}

async function waitReceipt(eth: Eip1193, hash: string, tries = 45): Promise<{ status: string } | null> {
	for (let i = 0; i < tries; i++) {
		const r = (await eth.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status: string } | null;
		if (r) return r;
		await sleep(2000);
	}
	return null;
}

export default function CrosschainReceive() {
	const { t } = useTranslation();
	const { recipient = "" } = useParams();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [sources, setSources] = useState<Source[]>([]);
	const [sourceChainId, setSourceChainId] = useState<number | null>(null);
	const [amount, setAmount] = useState("");
	const [mode, setMode] = useState<Mode>("fast");
	const [account, setAccount] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [done, setDone] = useState<{ completed: boolean; minutes: number; received: string } | null>(null);
	const [directAddress, setDirectAddress] = useState<string | null>(null);
	const [copiedDirect, setCopiedDirect] = useState(false);
	const [reviewing, setReviewing] = useState(false);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetch(`${SERVER_URL}/crosschain/inbound/config`);
				if (!res.ok) throw new Error();
				const data = await res.json();
				setEnabled(!!data.enabled);
				setSources(data.sources || []);
				if (data.sources?.length) setSourceChainId(data.sources[0].chainId);
			} catch {
				setEnabled(false);
			}
		})();
	}, []);

	// Same-network shortcut: if the payer already holds USDC on the destination
	// chain there is nothing to bridge — surface the recipient's plain address.
	useEffect(() => {
		(async () => {
			if (/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
				setDirectAddress(recipient);
				return;
			}
			try {
				const res = await fetch(`${SERVER_URL}/user/${encodeURIComponent(recipient)}`);
				if (!res.ok) return;
				const data = (await res.json()) as { walletAddress?: string | null };
				if (data.walletAddress) setDirectAddress(data.walletAddress);
			} catch {
				/* optional block; the bridge flow works without it */
			}
		})();
	}, [recipient]);

	async function copyDirectAddress() {
		if (!directAddress) return;
		try {
			await navigator.clipboard.writeText(directAddress);
			setCopiedDirect(true);
			setTimeout(() => setCopiedDirect(false), 2000);
		} catch {
			/* clipboard denied: the address is selectable as text */
		}
	}

	async function connect() {
		const eth = getEthereum();
		if (!eth) {
			setError(t("ccpay.noWallet"));
			return;
		}
		try {
			const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
			if (accounts?.[0]) setAccount(accounts[0]);
		} catch {
			setError(t("ccpay.connectError"));
		}
	}

	async function pay() {
		const eth = getEthereum();
		if (!eth || !account || !sourceChainId) return;
		setError("");
		try {
			setBusy(t("ccpay.preparing"));
			const prepRes = await fetch(`${SERVER_URL}/crosschain/inbound/prepare`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ recipient, sourceChainId, amount, mode }),
			});
			if (!prepRes.ok) {
				const e = await prepRes.json().catch(() => ({}));
				throw new Error(e.error || t("ccpay.prepareError"));
			}
			const prep = (await prepRes.json()) as Prepared;

			setBusy(t("ccpay.switchNetwork"));
			await ensureChain(eth, prep.sourceChainId);

			setBusy(t("ccpay.approving"));
			const approveHash = (await eth.request({
				method: "eth_sendTransaction",
				params: [{ from: account, to: prep.approveTx.to, data: prep.approveTx.data }],
			})) as string;
			const approveReceipt = await waitReceipt(eth, approveHash);
			if (!approveReceipt || approveReceipt.status === "0x0") throw new Error(t("ccpay.approveError"));

			setBusy(t("ccpay.sending"));
			const burnHash = (await eth.request({
				method: "eth_sendTransaction",
				params: [{ from: account, to: prep.burnTx.to, data: prep.burnTx.data }],
			})) as string;
			// Same validation as the approve: a reverted/unconfirmed burn must show
			// an error, never the success screen.
			const burnReceipt = await waitReceipt(eth, burnHash);
			if (!burnReceipt || burnReceipt.status === "0x0") throw new Error(t("ccpay.burnError"));

			// Tell GatoPago to relay the mint, then poll until delivered.
			await fetch(`${SERVER_URL}/crosschain/inbound/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ opId: prep.opId, sourceTxHash: burnHash }),
			});

			// The burn is final and the mint is the relayer's job (design I1: the
			// money is safe either way) — show "on its way" IMMEDIATELY instead of
			// holding the payer on a spinner for minutes. A background poll upgrades
			// the screen to "delivered" if it completes while still open.
			setBusy(null);
			setDone({ completed: false, minutes: prep.summary.estimatedMinutes, received: prep.summary.amountOutEstimated });
			for (let i = 0; i < 40; i++) {
				await sleep(3000);
				try {
					const sres = await fetch(`${SERVER_URL}/crosschain/inbound/status/${prep.opId}`);
					if (sres.ok) {
						const s = await sres.json();
						if (s.status === "completed") {
							setDone((d) => (d ? { ...d, completed: true } : d));
							break;
						}
						if (s.status === "failed" || s.status === "recoverable") break;
					}
				} catch {
					/* transient; keep polling */
				}
			}
		} catch (e) {
			setError((e as Error).message || t("ccpay.payError"));
		} finally {
			setBusy(null);
		}
	}

	const amountValid = Number(amount) > 0;
	const recipientLabel = recipient.startsWith("0x")
		? `${recipient.slice(0, 6)}…${recipient.slice(-4)}`
		: `@${recipient}`;
	const sourceName = sources.find((source) => source.chainId === sourceChainId)?.name ?? "—";

	// ===== Success / on-its-way =====
	if (done) {
		return (
			<Screen className="px-6">
				<TxResult
					state={done.completed ? "success" : "progress"}
					lead={done.completed ? t("ccpay.doneTitle", { name: recipientLabel }) : t("ccpay.onWayTitle", { name: recipientLabel })}
					amount={formatNumber(done.received, 6)}
					unit="USDC"
					body={done.completed ? t("ccpay.doneBody") : t("ccpay.onWayBody", { minutes: done.minutes })}
					bodyClassName="text-[13px] text-text-faint max-w-[300px] leading-relaxed"
				/>
			</Screen>
		);
	}

	return (
		<Screen className="pt-[calc(env(safe-area-inset-top)_+_2rem)]">
			{reviewing ? (
				<ConfirmSheet
					title={t("ccpay.confirmTitle")}
					amountLabel={t("ccpay.amount")}
					amount={formatNumber(amount, 6)}
					unit="USDC"
					warning={t("ccpay.twoTxHint")}
					confirmLabel={t("ccpay.confirmAction")}
					onConfirm={() => {
						setReviewing(false);
						void pay();
					}}
					onCancel={() => setReviewing(false)}
				>
					<InsetPanel className="mb-3">
						<SummaryRow label={t("ccpay.fromNetwork")} value={sourceName} />
						<SummaryRow label={t("ccpay.recipient")} value={recipientLabel} />
						<SummaryRow label={t("ccpay.speed")} value={mode === "fast" ? t("ccpay.fast") : t("ccpay.economic")} />
					</InsetPanel>
				</ConfirmSheet>
			) : null}
			<div className="flex flex-col items-center text-center mb-7">
				<Logo className="w-12 mb-4" />
				<p className="text-[13px] text-text-muted">{t("ccpay.payTo")}</p>
				<h1 className="font-display text-[24px]">{recipientLabel}</h1>
			</div>

			{enabled === null ? (
				<FormPageSkeleton />
			) : !enabled ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<p className="text-[14px] text-text-muted max-w-[280px] leading-relaxed">{t("ccpay.disabled")}</p>
				</div>
			) : (
				<>
					{/* Source network */}
					<SectionLabel>{t("ccpay.fromNetwork")}</SectionLabel>
					<NetworkChips
						options={sources.map((s) => ({ id: s.chainId, label: s.name }))}
						selected={sourceChainId}
						onSelect={setSourceChainId}
					/>

					{/* Amount */}
					<MoneyPanel className="mb-5">
						<p className="text-[13px] text-text-muted mb-3">{t("ccpay.amount")}</p>
						<div className="flex items-center gap-3">
							<AmountInput
								name="amount"
								aria-label={t("ccpay.amount")}
								placeholder="0"
								value={amount}
								onChange={setAmount}
								className="flex-1 min-w-0 bg-transparent font-display text-[34px] leading-none text-text placeholder:text-text-faint tabular"
							/>
							<span className="text-[15px] text-text-muted font-medium shrink-0">USDC</span>
						</div>
					</MoneyPanel>

					{/* Speed */}
					<div className="seg-track seg-track-block mb-2">
						{(
							[
								["fast", t("ccpay.fast")],
								["standard", t("ccpay.economic")],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								onClick={() => setMode(value)}
								aria-pressed={mode === value}
								data-active={mode === value}
								className="seg-item"
							>
								{label}
							</button>
						))}
					</div>
					<p className="text-[12px] text-text-faint px-1 mb-5 leading-relaxed">
						{mode === "fast" ? t("ccpay.modeHintFast") : t("ccpay.modeHintStandard")}
					</p>

					{/* Same-network shortcut: no bridge needed if the USDC is already here. */}
					{directAddress && (
						<NoticeCard title={t("ccpay.directTitle", { network: activeNetwork.name })} className="mb-5">
							<p className="text-[11px] text-text-faint mb-2 leading-relaxed">{t("ccpay.directBody")}</p>
							<div className="flex items-center gap-2">
								<span className="text-[12px] text-text font-mono break-all flex-1 select-all">{directAddress}</span>
								<button
									onClick={() => void copyDirectAddress()}
									className="shrink-0 text-[12px] font-semibold text-cat-300"
								>
									{copiedDirect ? t("common.copied") : t("common.copy")}
								</button>
							</div>
						</NoticeCard>
					)}

					{error && (
						<p role="status" aria-live="polite" className="mb-4 text-center text-[13px] text-danger">
							{error}
						</p>
					)}
					{busy && (
						<p role="status" aria-live="polite" className="text-[13px] text-text-muted text-center mb-4 animate-pulse-soft">
							{busy}
						</p>
					)}

					<TransactionActions
						hint={account
							? <><span className="block">{t("ccpay.connectedHint", { addr: `${account.slice(0, 6)}…${account.slice(-4)}` })}</span><span className="block mt-1">{t("ccpay.twoTxHint")}</span></>
							: t("ccpay.hint")}
					>
						{!account ? (
							<button onClick={connect} className="btn btn-primary btn-block">
								{t("ccpay.connect")}
							</button>
						) : (
							<button onClick={() => setReviewing(true)} disabled={!amountValid || !sourceChainId || !!busy} className="btn btn-primary btn-block">
								{t("ccpay.pay")}
							</button>
						)}
					</TransactionActions>
				</>
			)}
		</Screen>
	);
}
