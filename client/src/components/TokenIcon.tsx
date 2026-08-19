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
