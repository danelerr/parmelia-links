import { useNavigate } from "react-router-dom";
import { logOut, type User } from "../firebase";
import { useState, useRef } from "react";
import useSWR from "swr";
import { toPng } from "html-to-image";
import { fetchWithAuth } from "../authFetch";
import Logo from "../components/Logo";
import { activeNetwork, getExplorerTxUrl } from "../network";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

interface Transaction {
	type: "sent" | "received";
	txHash: string;
	amount: string;
	currency: string;
	to?: string;
	reference?: string;
	createdAt: string;
}

export default function Home({ user }: { user: User }) {
	const navigate = useNavigate();
	const [showMenu, setShowMenu] = useState(false);
	const [showQrMenu, setShowQrMenu] = useState(false);
	const [copied, setCopied] = useState(false);
	const [selectedCurrency, setSelectedCurrency] = useState<"USDC" | "ETH">("USDC");
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
	const txCardRef = useRef<HTMLDivElement>(null);

	// Custom fetcher for SWR
	const fetcher = async (url: string) => {
		const res = await fetchWithAuth(user, url);
		if (!res.ok) throw new Error("API error");
		return res.json();
	};

	// SWR Hooks for Data Fetching
	const { data: profile } = useSWR(`${SERVER_URL}/user/profile`, fetcher, {
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});

	const { data: balance, isLoading: isBalanceLoading } = useSWR(
		profile?.walletAddress ? `${SERVER_URL}/user/balance` : null,
		fetcher,
		{ refreshInterval: 10000, keepPreviousData: true }
	);

	const { data: txData, isLoading: isTxLoading } = useSWR(
		profile?.walletAddress ? `${SERVER_URL}/user/transactions` : null,
		fetcher,
		{ refreshInterval: 15000, keepPreviousData: true }
	);

	const { data: passkeyStatus } = useSWR(
		profile?.walletAddress ? `${SERVER_URL}/account/passkey` : null,
		fetcher,
		{ refreshInterval: 30000, keepPreviousData: true }
	);

	// Parse Transactions
	let transactions: Transaction[] = [];
	if (txData) {
		const sent = (txData.sent || []).map((t: any) => ({
			type: "sent" as const,
			txHash: t.txHash,
			amount: t.amount,
			currency: t.currency,
			to: t.to,
			createdAt: t.createdAt,
		}));
		const received = (txData.received || []).map((t: any) => ({
			type: "received" as const,
			txHash: t.txHash,
			amount: t.amount,
			currency: t.currency,
			reference: t.reference,
			createdAt: t.createdAt,
		}));
		transactions = [...sent, ...received].sort(
			(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		);
	}

	const walletAddress = profile?.walletAddress || null;
	const username = profile?.username || null;
	const ethBalance = balance?.eth ?? null;
	const usdcBalance = balance?.usdc ?? null;

	function handleCopyAddress() {
		if (!walletAddress) return;
		navigator.clipboard.writeText(walletAddress);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-28 relative w-full max-w-lg mx-auto">
			{/* Header */}
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-2">
					<Logo className="w-7" />
					<span className="text-xs text-muted">Parmelia ({activeNetwork.name})</span>
				</div>
				<button
					onClick={() => setShowMenu(!showMenu)}
					className="w-10 h-10 rounded-full bg-parmelia-pink flex items-center justify-center overflow-hidden"
				>
					{user.photoURL ? (
						<img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
					) : (
						<span className="text-black text-sm font-bold uppercase">
							{username ? username[0] : "?"}
						</span>
					)}
				</button>
			</div>

			{/* Dropdown menu */}
			{showMenu && (
				<div className="absolute top-16 right-5 sm:right-8 bg-surface rounded-xl p-2 z-50 min-w-45 shadow-xl border border-surface-2">
					<button
						onClick={() => { setShowMenu(false); navigate("/settings"); }}
						className="w-full text-left px-4 py-3 text-sm rounded-lg hover:bg-surface-2 text-white transition-colors"
					>
						Configuracion
					</button>
					{username && (
						<button
							onClick={() => { setShowMenu(false); }}
							className="w-full text-left px-4 py-3 text-sm rounded-lg hover:bg-surface-2 text-muted transition-colors"
						>
							@{username}
						</button>
					)}
					<div className="border-t border-surface-2 mx-2 my-1" />
					<button
						onClick={() => { setShowMenu(false); logOut(); }}
						className="w-full text-left px-4 py-3 text-sm rounded-lg hover:bg-surface-2 text-parmelia-pink transition-colors"
					>
						Cerrar sesion
					</button>
				</div>
			)}

			{/* Balance card */}
			<div className="bg-surface rounded-2xl p-6 sm:p-8 mb-5 relative overflow-hidden">
				{isBalanceLoading && !balance && (
					<div className="absolute inset-0 bg-surface z-10 flex items-center justify-center">
						<div className="w-6 h-6 border-2 border-parmelia-blue border-t-transparent rounded-full animate-spin"></div>
					</div>
				)}

				{/* Currency selector */}
				<div className="flex justify-center gap-2 mb-4">
					<button
						onClick={() => setSelectedCurrency("USDC")}
						className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${selectedCurrency === "USDC"
							? "bg-parmelia-blue text-black"
							: "bg-surface-2 text-muted"
							}`}
					>
						USDC
					</button>
					<button
						onClick={() => setSelectedCurrency("ETH")}
						className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${selectedCurrency === "ETH"
							? "bg-parmelia-blue text-black"
							: "bg-surface-2 text-muted"
							}`}
					>
						ETH
					</button>
				</div>

				<div className="flex flex-col items-center mb-4">
					{selectedCurrency === "USDC" ? (
						<>
							<span className="text-3xl sm:text-4xl font-mono mb-1">
								{usdcBalance !== null ? `$${usdcBalance}` : "$0"}
							</span>
							<span className="text-xs text-muted">USDC</span>
						</>
					) : (
						<>
							<span className="text-3xl sm:text-4xl font-mono mb-1">
								{ethBalance !== null ? ethBalance : "0"}
							</span>
							<span className="text-xs text-muted">ETH</span>
						</>
					)}
				</div>

				<button
					onClick={handleCopyAddress}
					className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs text-muted hover:text-white hover:bg-surface-2 transition-colors"
				>
					<span className="font-mono truncate max-w-[200px]">{walletAddress || "Cargando..."}</span>
					<span className="text-xs">{copied ? "[copiado]" : "[copiar]"}</span>
				</button>
			</div>

			{passkeyStatus?.hasWallet && (
				<div className="bg-surface rounded-2xl p-4 mb-5">
					<div className="flex items-center justify-between gap-3 mb-2">
						<h2 className="text-xs text-muted">Protección de cuenta</h2>
						<span
							className={`text-[11px] px-2.5 py-1 rounded-full ${
								passkeyStatus.accountVersion === "v2"
									? "bg-parmelia-blue/20 text-parmelia-blue"
									: "bg-parmelia-gold/20 text-parmelia-gold"
							}`}
						>
							{passkeyStatus.accountVersion === "v2" ? "V2" : "Legacy"}
						</span>
					</div>

					{passkeyStatus.accountVersion === "v2" ? (
						<p className="text-sm text-white leading-relaxed">
							{passkeyStatus.signerCount || 1} passkeys activas, threshold{" "}
							{passkeyStatus.threshold || 1} y recovery con guardian{" "}
							{passkeyStatus.guardian &&
							passkeyStatus.guardian !== "0x0000000000000000000000000000000000000000"
								? "activo"
								: "sin configurar"}
							.
						</p>
					) : (
						<p className="text-sm text-muted leading-relaxed">
							Esta wallet todavía no expone multi-passkey on-chain. Los
							detalles de migración y seguridad están en Configuración.
						</p>
					)}
				</div>
			)}

			{/* Transactions */}
			<div className="bg-surface rounded-2xl p-5 sm:p-6 flex-1 mb-5 relative min-h-[150px]">
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-xs text-muted">Transacciones</h2>
					{isTxLoading && txData && (
						<span className="w-2 h-2 rounded-full bg-parmelia-blue animate-pulse"></span>
					)}
				</div>

				{isTxLoading && !txData ? (
					<div className="absolute inset-0 z-10 flex items-center justify-center">
						<div className="w-5 h-5 border-2 border-surface-2 border-t-parmelia-blue rounded-full animate-spin"></div>
					</div>
				) : transactions.length === 0 ? (
					<p className="text-muted text-sm text-center py-10">Sin transacciones</p>
				) : (
					<div className="flex flex-col gap-4 items-center">
						{transactions.map((tx, i) => (
							<button
								key={tx.txHash + i}
								onClick={() => setSelectedTx(tx)}
								className="flex items-center justify-between py-3 border-b border-surface-2 last:border-0 hover:bg-surface-2/50 -mx-2 px-2 rounded-lg transition-colors text-left w-full"
							>
								<div>
									<p className="text-sm mb-0.5">
										{tx.type === "sent" ? "Enviado" : (tx.reference || "Recibido")}
									</p>
									<p className="text-xs text-muted">
										{tx.type === "sent" ? "-" : "+"}{tx.amount} {tx.currency}
									</p>
								</div>
								<span className={`text-xs px-3 py-1.5 rounded-full ${tx.type === "sent"
									? "bg-parmelia-pink/20 text-parmelia-pink"
									: "bg-parmelia-blue/20 text-parmelia-blue"
									}`}>
									{tx.type === "sent" ? "Enviado" : "Recibido"}
								</span>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Transaction detail modal */}
			{selectedTx && (
				<div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-5 flex-col gap-4" onClick={() => setSelectedTx(null)}>
					<div ref={txCardRef} className="w-full max-w-sm flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
						<div className="bg-surface rounded-2xl p-8 w-full flex flex-col items-center relative">
							<Logo className="w-14 mb-6" />
							<h2 className="text-3xl mb-4">
								{selectedTx.type === "sent" ? "Pagaste" : "Recibiste"}
							</h2>
							<p className={`text-xl mb-3 ${selectedTx.type === "sent" ? "text-parmelia-pink" : "text-parmelia-blue"}`}>
								{selectedTx.type === "sent" ? "-" : "+"}{selectedTx.amount} {selectedTx.currency}
							</p>
							{selectedTx.to && (
								<p className="text-muted text-xs font-mono break-all text-center px-2 mb-3">
									A {selectedTx.to.slice(0, 6)}...{selectedTx.to.slice(-4)}
								</p>
							)}
							{selectedTx.reference && (
								<p className="text-muted text-sm text-center mb-3">{selectedTx.reference}</p>
							)}
							<div className="w-14 h-14 rounded-full bg-muted/30 flex items-center justify-center mb-4">
								<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
									<polyline points="20 6 9 17 4 12" />
								</svg>
							</div>

							{selectedTx.txHash && (
								<a
									href={getExplorerTxUrl(selectedTx.txHash)}
									target="_blank"
									rel="noopener noreferrer"
									className="text-parmelia-blue text-sm underline mt-2 text-center"
								>
									Comprobante onchain ↗
								</a>
							)}
						</div>
					</div>

					<div className="flex gap-3 w-full max-w-sm px-4 mt-2" onClick={(e) => e.stopPropagation()}>
						<button
							onClick={async () => {
								if (!txCardRef.current) return;
								try {
									const dataUrl = await toPng(txCardRef.current, {
										backgroundColor: '#000000',
										width: txCardRef.current.offsetWidth + 64,
										height: txCardRef.current.offsetHeight + 64,
										style: {
											flex: 'none',
											padding: '32px',
											margin: '0',
											maxWidth: 'none'
										},
										pixelRatio: 2
									});
									const a = document.createElement("a");
									a.download = `parmelia-tx-${selectedTx.amount}-${selectedTx.currency}.png`;
									a.href = dataUrl;
									a.click();
								} catch { /* ignore */ }
							}}
							className="flex-1 bg-parmelia-blue text-black py-3 rounded-full text-sm font-medium"
						>
							Descargar
						</button>
						<button
							onClick={() => setSelectedTx(null)}
							className="flex-1 bg-surface-2 text-white py-3 rounded-full text-sm font-medium"
						>
							Cerrar
						</button>
					</div>
				</div>
			)}

			{/* QR Button bottom center */}
			<div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40">
				<button
					onClick={() => setShowQrMenu(!showQrMenu)}
					className="w-16 h-16 rounded-full bg-parmelia-gold flex items-center justify-center"
				>
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="2" y="2" width="8" height="8" rx="1" />
						<rect x="14" y="2" width="8" height="8" rx="1" />
						<rect x="2" y="14" width="8" height="8" rx="1" />
						<rect x="14" y="14" width="4" height="4" rx="0.5" />
						<path d="M22 14h-4v4" />
						<path d="M18 22h4v-4" />
					</svg>
				</button>

				{/* QR Menu popup */}
				{showQrMenu && (
					<div className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-surface rounded-xl p-2 min-w-[160px] shadow-xl border border-surface-2">
						<button
							onClick={() => { setShowQrMenu(false); navigate("/cobrar"); }}
							className="w-full text-left px-4 py-3 text-sm rounded-lg hover:bg-surface-2 text-white transition-colors"
						>
							Cobrar
						</button>
						<div className="border-t border-surface-2 mx-2 my-1" />
						<button
							onClick={() => { setShowQrMenu(false); navigate("/scan"); }}
							className="w-full text-left px-4 py-3 text-sm rounded-lg hover:bg-surface-2 text-white transition-colors"
						>
							Pagar
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
