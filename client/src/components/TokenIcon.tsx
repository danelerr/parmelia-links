import ethLogo from "../assets/tokens/eth.webp?no-inline";
import usdcLogo from "../assets/tokens/usdc.webp?no-inline";
import wbtcLogo from "../assets/tokens/wbtc.webp?no-inline";

const TOKEN_ASSETS: Record<string, string> = {
	USDC: usdcLogo,
	ETH: ethLogo,
	WBTC: wbtcLogo,
};

const TOKEN_COLORS: Record<string, string> = {
	USDC: "#2775CA",
	ETH: "#627EEA",
	WBTC: "#F7931A",
	AVAX: "#E84142",
};

export default function TokenIcon({
	symbol,
	size = 28,
	className = "",
}: {
	symbol: string;
	size?: number;
	className?: string;
}) {
	const normalized = symbol.toUpperCase();
	const asset = TOKEN_ASSETS[normalized];
	// Avalanche mark path from the open cryptocurrency-icons asset set; colors
	// and geometry match the official AVAX token identity.
	if (normalized === "AVAX") {
		return (
			<svg aria-hidden="true" width={size} height={size} viewBox="0 0 32 32" className={`token-icon shrink-0 ${className}`}>
				<circle fill="#E84142" cx="16" cy="16" r="16" />
				<path d="M11.518 22.75H8.49c-.636 0-.95 0-1.142-.123A.77.77 0 017 22.025c-.012-.226.145-.503.46-1.055l7.472-13.193c.318-.56.48-.84.682-.944a.77.77 0 01.698 0c.203.104.364.384.682.944l1.536 2.686.008.014c.343.6.517.906.593 1.226a2.26 2.26 0 010 1.066c-.076.323-.249.63-.597 1.24l-3.926 6.95-.01.017c-.346.606-.52.913-.764 1.145a2.284 2.284 0 01-.93.54c-.319.089-.675.089-1.387.089zm7.643 0h4.336c.64 0 .962 0 1.154-.126a.768.768 0 00.348-.607c.011-.219-.142-.484-.443-1.005l-.032-.054-2.172-3.722-.025-.042c-.305-.517-.46-.778-.657-.879a.762.762 0 00-.693 0c-.2.104-.36.377-.678.925l-2.165 3.722-.007.013c-.317.548-.476.821-.464 1.046a.777.777 0 00.348.606c.188.123.51.123 1.15.123z" fill="#FFF" />
			</svg>
		);
	}

	if (asset) {
		return (
			<img
				src={asset}
				alt=""
				aria-hidden="true"
				width={size}
				height={size}
				decoding="async"
				draggable={false}
				className={`token-icon shrink-0 object-contain ${className}`}
			/>
		);
	}

	return (
		<span
			aria-hidden="true"
			className={`token-icon inline-flex shrink-0 items-center justify-center font-semibold text-on-cat ${className}`}
			style={{
				width: size,
				height: size,
				background: TOKEN_COLORS[normalized] ?? "var(--color-cat-500)",
				fontSize: Math.max(9, size * 0.36),
			}}
		>
			{normalized.slice(0, 2)}
		</span>
	);
}
