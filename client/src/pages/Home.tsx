import { useNavigate } from "react-router-dom";
import { logOut, type User } from "../firebase";
import { useCallback, useEffect, useState, useRef } from "react";
import { sileo } from "sileo";
import { toPng } from "html-to-image";
import { fetchWithAuth } from "../authFetch";
import { createPasskey } from "../webauthn";
import Logo from "../components/Logo";

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
	const [transactions, setTransactions] = useState<Transaction[]>([]);
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [username, setUsername] = useState<string | null>(null);
	const [showMenu, setShowMenu] = useState(false);
	const [showQrMenu, setShowQrMenu] = useState(false);
	const [creatingWallet, setCreatingWallet] = useState(false);
	const [ethBalance, setEthBalance] = useState<string | null>(null);
	const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [selectedCurrency, setSelectedCurrency] = useState<"USDC" | "ETH">("USDC");
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
	const txCardRef = useRef<HTMLDivElement>(null);

	const fetchBalance = useCallback(async () => {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/balance`);
			if (res.ok) {
				const data = await res.json();
				setEthBalance(data.eth);
				setUsdcBalance(data.usdc);
			}
		} catch {
			// Balance not available
		}
	}, [user]);

	const fetchTransactions = useCallback(async () => {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/transactions`);
			if (res.ok) {
				const data = await res.json();
				const sent: Transaction[] = (data.sent || []).map((t: any) => ({
					type: "sent" as const,
					txHash: t.txHash,
					amount: t.amount,
					currency: t.currency,
					to: t.to,
					createdAt: t.createdAt,
				}));
				const received: Transaction[] = (data.received || []).map((t: any) => ({
					type: "received" as const,
					txHash: t.txHash,
					amount: t.amount,
					currency: t.currency,
					reference: t.reference,
					createdAt: t.createdAt,
				}));
				const all = [...sent, ...received].sort(
					(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
				);
				setTransactions(all);
			}
		} catch {
			// No transactions
		}
	}, [user]);

	useEffect(() => {
		async function fetchProfile() {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/user/profile`);
				if (res.ok) {
					const data = await res.json();
					setWalletAddress(data.walletAddress || null);
					setUsername(data.username || null);
					if (data.walletAddress) fetchBalance();
				}
			} catch {
				// Profile not created yet
			}
		}

		fetchProfile();
		fetchTransactions();
	}, [user, fetchBalance, fetchTransactions]);

	function handleCopyAddress() {
		if (!walletAddress) return;
		navigator.clipboard.writeText(walletAddress);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
		sileo.success({ title: "Direccion copiada" });
	}

	async function handleCreateWallet() {
		setCreatingWallet(true);
		try {
			// 1. Create passkey on the device (biometric prompt)
			const uid = user.uid || "parmelia-user";
			const { credentialId, qx, qy } = await createPasskey(uid);

			// 2. Send public key to server to deploy the smart account
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credentialId, qx, qy }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: "Error al crear wallet" }));
				throw new Error(data.error || "Error al crear wallet");
			}
			const data = await res.json();
			setWalletAddress(data.accountAddress);
			setUsdcBalance("0");
			setEthBalance("0");
			sileo.success({ title: "Wallet creada", description: "¡Recibiste 5 USDC de bienvenida!" });
			// Refresh balance to show the auto-funded amount
			setTimeout(() => fetchBalance(), 3000);
		} catch (err) {
			sileo.error({ title: "Error", description: err instanceof Error ? err.message : "Error al crear wallet" });
		} finally {
			setCreatingWallet(false);
		}
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-28 relative w-full max-w-lg mx-auto">
			{/* Header */}
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-2">
					<Logo className="w-7" />
					<span className="text-xs text-muted">Base Sepolia</span>
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

			{/* Create wallet prompt */}
			{!walletAddress && (
				<div className="bg-surface rounded-2xl p-6 sm:p-8 mb-5 text-center">
					<p className="text-muted mb-4 text-sm leading-relaxed">Necesitas una wallet para recibir pagos</p>
					<button
						onClick={handleCreateWallet}
						disabled={creatingWallet}
						className="bg-parmelia-blue text-black px-8 py-3 rounded-full text-sm font-medium transition-opacity disabled:opacity-50"
					>
						{creatingWallet ? "Creando..." : "Crear Cuenta"}
					</button>
				</div>
			)}

			{/* Balance card */}
			{walletAddress && (
				<div className="bg-surface rounded-2xl p-6 sm:p-8 mb-5">
					{/* Currency selector */}
					<div className="flex justify-center gap-2 mb-4">
						<button
							onClick={() => setSelectedCurrency("USDC")}
							className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
								selectedCurrency === "USDC"
									? "bg-parmelia-blue text-black"
									: "bg-surface-2 text-muted"
							}`}
						>
							USDC
						</button>
						<button
							onClick={() => setSelectedCurrency("ETH")}
							className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
								selectedCurrency === "ETH"
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
						<span className="font-mono truncate max-w-[200px]">{walletAddress}</span>
						<span className="text-xs">{copied ? "[copiado]" : "[copiar]"}</span>
					</button>
				</div>
			)}

			{/* Transactions */}
			<div className="bg-surface rounded-2xl p-5 sm:p-6 flex-1 mb-5">
				<h2 className="text-xs text-muted mb-3">Transacciones</h2>
				{transactions.length === 0 ? (
					<p className="text-muted text-sm text-center py-10">Sin transacciones</p>
				) : (
					<div className="flex flex-col gap-4">
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
								<span className={`text-xs px-3 py-1.5 rounded-full ${
									tx.type === "sent"
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
				<div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-5" onClick={() => setSelectedTx(null)}>
					<div className="bg-surface rounded-2xl p-8 w-full max-w-sm flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
						<div ref={txCardRef} className="flex flex-col items-center w-full">
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
						</div>
						{selectedTx.txHash && (
							<a
								href={`https://base-sepolia.blockscout.com/tx/${selectedTx.txHash}`}
								target="_blank"
								rel="noopener noreferrer"
								className="text-parmelia-blue text-sm underline mb-4"
							>
								Comprobante onchain ↗
							</a>
						)}
						<div className="flex gap-3 w-full mt-2">
							<button
								onClick={async () => {
									if (!txCardRef.current) return;
									try {
										const dataUrl = await toPng(txCardRef.current, { pixelRatio: 2 });
										const a = document.createElement("a");
										a.download = `parmelia-tx-${selectedTx.amount}-${selectedTx.currency}.png`;
										a.href = dataUrl;
										a.click();
									} catch { /* ignore */ }
								}}
								className="flex-1 bg-parmelia-blue text-black py-2.5 rounded-full text-xs font-medium"
							>
								Descargar
							</button>
							<button
								onClick={() => setSelectedTx(null)}
								className="flex-1 bg-surface-2 text-white py-2.5 rounded-full text-xs font-medium"
							>
								Cerrar
							</button>
						</div>
					</div>
				</div>
			)}

			{/* QR Button bottom center */}
			<div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40">
				<button
					onClick={() => setShowQrMenu(!showQrMenu)}
					className="w-16 h-16 rounded-full bg-parmelia-gold flex items-center justify-center shadow-lg shadow-parmelia-gold/20"
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
