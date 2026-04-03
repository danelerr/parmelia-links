import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	type Hex,
	encodeFunctionData,
	encodeAbiParameters,
	parseAbiParameters,
	encodePacked,
	createPublicClient,
	createWalletClient,
	http,
	concat,
	pad,
	toHex,
	formatEther,
	formatUnits,
	parseUnits,
	parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkConfig } from "../../../shared/networks";
import {
	ENTRYPOINT_ADDRESS,
	PAYMASTER_ADDRESS,
	VERIFIER_ADDRESS,
	accountWebAuthnV2Abi,
	entryPointAbi,
	erc20Abi,
	USDC_ADDRESS,
	USDC_DECIMALS,
} from "../../../shared";
import { getActiveChain } from "../chain";
import {
	createPendingPayment,
	deletePendingPayment,
	getPaymentLinkById,
	getPendingPayment,
	getUserByUid,
	markPaymentLinkPaid,
	recordSentTransaction,
	saveUser,
} from "../services/storage";
import { buildSignedPaymasterAndData } from "../services/paymaster";

const payRoutes = new Hono<AppContext>();
const CLIENT_SIDE_PAYMENT_IDS = new Set(["direct", "username", "manual"]);

function buildExecuteCalldata(target: `0x${string}`, value: bigint, data: Hex): Hex {
	const mode = pad("0x01", { size: 32, dir: "right" }) as Hex;
	const executionData = encodeAbiParameters(
		parseAbiParameters("(address target, uint256 value, bytes callData)[]"),
		[[{ target, value, callData: data }]],
	);
	return encodeFunctionData({
		abi: [{ name: "execute", type: "function", inputs: [{ name: "mode", type: "bytes32" }, { name: "executionData", type: "bytes" }], outputs: [] }],
		functionName: "execute",
		args: [mode, executionData],
	});
}

function serializeBigInts(obj: any): any {
	if (typeof obj === "bigint") return "0x" + obj.toString(16);
	if (Array.isArray(obj)) return obj.map(serializeBigInts);
	if (obj !== null && typeof obj === "object") {
		return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, serializeBigInts(v)]));
	}
	return obj;
}

function normalizePositiveAmount(amount: unknown): string | null {
	if (amount === undefined || amount === null) return null;
	const normalized = String(amount).trim();
	if (!normalized) return null;
	const numeric = Number(normalized);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return normalized;
}

function normalizeCurrency(currency: unknown): "USDC" | "ETH" | null {
	if (typeof currency !== "string") return null;
	const normalized = currency.trim().toUpperCase();
	if (normalized === "USDC" || normalized === "ETH") return normalized;
	return null;
}

function normalizeWalletAddress(wallet: unknown): `0x${string}` | null {
	if (typeof wallet !== "string") return null;
	const normalized = wallet.trim();
	if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return null;
	return normalized as `0x${string}`;
}

function isStoredPaymentLink(linkId: unknown): linkId is string {
	return typeof linkId === "string" && linkId.length > 0 && !CLIENT_SIDE_PAYMENT_IDS.has(linkId);
}

function wrapMultiSignerSignature(
	signer: Hex,
	webAuthnSignature: Hex,
): Hex {
	return encodeAbiParameters(
		parseAbiParameters("bytes[] signers, bytes[] signatures"),
		[[signer], [webAuthnSignature]],
	);
}

payRoutes.post("/prepare", requireAuth, async (c) => {
	try {
		const user = c.get("user")!;
		const body = (await c.req.json()) as Record<string, unknown>;
		const linkId = body.linkId;

		const profile = await getUserByUid(c.env, user.sub);
		const senderAddress = profile?.walletAddress ?? undefined;
		if (!senderAddress) return c.json({ error: "You need a wallet to pay. Create one first." }, 400);

		const credentialId = profile?.credentialId ?? null;
		const activeChain = getActiveChain(c.env.CHAIN_KEY);
		const nativeTokenSymbol = getNetworkConfig(c.env.CHAIN_KEY).nativeTokenSymbol;
		const publicClient = createPublicClient({ chain: activeChain, transport: http(c.env.RPC_URL) });

		let recipientAddress: `0x${string}` | null = null;
		let paymentAmount: string | null = null;
		let paymentCurrency: "USDC" | "ETH" | null = null;
		let pendingLinkId: string | null = typeof linkId === "string" ? linkId : null;

		if (isStoredPaymentLink(linkId)) {
			const link = await getPaymentLinkById(c.env, linkId);
			if (!link) {
				return c.json({ error: "Link de pago no encontrado" }, 404);
			}
			if (link.status === "paid") {
				return c.json({ error: "Este link ya fue pagado" }, 400);
			}

			recipientAddress = normalizeWalletAddress(link.wallet);
			paymentCurrency = normalizeCurrency(link.currency) ?? "USDC";
			paymentAmount = Number(link.amount) > 0 ? link.amount : normalizePositiveAmount(body.amount);
		} else {
			recipientAddress = normalizeWalletAddress(body.wallet);
			paymentCurrency = normalizeCurrency(body.currency);
			paymentAmount = normalizePositiveAmount(body.amount);
			// Client-side payment IDs like "manual", "direct", "username" are NOT
			// real payment_links rows, so they must be stored as NULL to avoid
			// a FOREIGN KEY constraint violation on pending_payments.link_id.
			pendingLinkId = null;
		}

		if (!recipientAddress) {
			return c.json({ error: "Wallet inválida" }, 400);
		}
		if (!paymentCurrency) {
			return c.json({ error: "Currency must be USDC or ETH" }, 400);
		}
		if (!paymentAmount) {
			return c.json({ error: "El monto debe ser mayor a 0" }, 400);
		}

		let executeCalldata: Hex;

		if (paymentCurrency === "USDC") {
			let usdcAmount: bigint;
			try {
				usdcAmount = parseUnits(paymentAmount, USDC_DECIMALS);
			} catch {
				return c.json({ error: "Monto inválido para USDC" }, 400);
			}

			const usdcBalance = (await publicClient.readContract({
				address: USDC_ADDRESS as `0x${string}`,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [senderAddress as `0x${string}`],
			})) as bigint;
			if (usdcBalance < usdcAmount) {
				return c.json({ error: `Saldo USDC insuficiente (tienes ${formatUnits(usdcBalance, USDC_DECIMALS)} USDC)` }, 400);
			}
			const transferData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipientAddress, usdcAmount] });
			executeCalldata = buildExecuteCalldata(USDC_ADDRESS as `0x${string}`, 0n, transferData);
		} else {
			let ethAmount: bigint;
			try {
				ethAmount = parseEther(paymentAmount);
			} catch {
				return c.json({ error: "Monto inválido para ETH" }, 400);
			}

			const ethBalance = await publicClient.getBalance({ address: senderAddress as `0x${string}` });
			if (ethBalance < ethAmount) {
				return c.json({
					error: `Saldo ${nativeTokenSymbol} insuficiente (tienes ${formatEther(ethBalance)} ${nativeTokenSymbol})`,
				}, 400);
			}
			executeCalldata = buildExecuteCalldata(recipientAddress, ethAmount, "0x");
		}

		const nonce = (await publicClient.readContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "getNonce",
			args: [senderAddress as `0x${string}`, 0n],
		})) as bigint;

		const gasPrice = await publicClient.getGasPrice();
		const maxFeePerGas = gasPrice * 2n;
		const maxPriorityFeePerGas = gasPrice / 10n > 1000000n ? gasPrice / 10n : 1000000n;

		const accountGasLimits = concat([pad(toHex(500000n), { size: 16 }), pad(toHex(300000n), { size: 16 })]) as Hex;
		const gasFees = concat([pad(toHex(maxPriorityFeePerGas), { size: 16 }), pad(toHex(maxFeePerGas), { size: 16 })]) as Hex;
		const userOp = {
			sender: senderAddress as `0x${string}`,
			nonce,
			initCode: "0x" as Hex,
			callData: executeCalldata,
			accountGasLimits,
			preVerificationGas: 100000n,
			gasFees,
			paymasterAndData: "0x" as Hex,
			signature: "0x" as Hex,
		};

		const chainId = await publicClient.getChainId();
		const paymasterSignerPrivateKey = (c.env.PAYMASTER_SIGNER_PRIVATE_KEY ||
			c.env.PRIVATE_KEY) as `0x${string}`;
		userOp.paymasterAndData = await buildSignedPaymasterAndData({
			chainId,
			paymasterAddress: PAYMASTER_ADDRESS as `0x${string}`,
			userOp,
			signerPrivateKey: paymasterSignerPrivateKey,
		});

		const userOpHash = (await publicClient.readContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "getUserOpHash",
			args: [userOp],
		})) as Hex;

		await createPendingPayment(c.env, {
			userOpHash,
			linkId: pendingLinkId,
			uid: user.sub,
			amount: paymentAmount,
			currency: paymentCurrency,
			wallet: recipientAddress,
			senderAddress,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
		});

		return c.json({ userOpHash, credentialId });
	} catch (error) {
		console.error("Prepare error:", error);
		return c.json({ error: "Error al preparar el pago." }, 500);
	}
});

payRoutes.post("/submit", requireAuth, async (c) => {
	try {
		const user = c.get("user")!;
		const { userOpHash, authenticatorData, clientDataJSON, r, s, credentialId, qx, qy } = await c.req.json();
		if (!userOpHash || !authenticatorData || !clientDataJSON || !r || !s) {
			return c.json({ error: "Missing signature data" }, 400);
		}

		const pending = await getPendingPayment(c.env, userOpHash);
		if (!pending) return c.json({ error: "No pending payment found" }, 404);
		if (pending.uid !== user.sub) return c.json({ error: "Unauthorized" }, 403);
		const activeChain = getActiveChain(c.env.CHAIN_KEY);
		const publicClient = createPublicClient({ chain: activeChain, transport: http(c.env.RPC_URL) });

		const typeIndex = (clientDataJSON as string).indexOf('"type"');
		const challengeIndex = (clientDataJSON as string).indexOf('"challenge"');

		const P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
		let normalizedS = BigInt(s as string);
		if (normalizedS > P256_N / 2n) normalizedS = P256_N - normalizedS;
		const normalizedSHex = ("0x" + normalizedS.toString(16).padStart(64, "0")) as Hex;

		// Inner signature: WebAuthn authentication assertion (same as V1)
		const webAuthnSignature = encodeAbiParameters(
			parseAbiParameters("bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON"),
			[r as Hex, normalizedSHex, BigInt(challengeIndex), BigInt(typeIndex), authenticatorData as Hex, clientDataJSON as string],
		);

		let signature: Hex;

		if (qx && qy) {
			const signerBytes = encodePacked(
				["address", "bytes32", "bytes32"],
				[VERIFIER_ADDRESS as `0x${string}`, qx as `0x${string}`, qy as `0x${string}`],
			);
			signature = wrapMultiSignerSignature(signerBytes, webAuthnSignature);
		} else {
			try {
				const signerCount = (await publicClient.readContract({
					address: pending.senderAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "getSignerCount",
				})) as bigint;

				if (signerCount !== 1n) {
					return c.json({
						error:
							"Missing qx/qy for a multi-passkey wallet. Sign again from a device that knows this passkey.",
					}, 400);
				}

				const signers = (await publicClient.readContract({
					address: pending.senderAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "getSigners",
					args: [0, 1],
				})) as Hex[];

				const signerBytes = signers[0];
				if (!signerBytes) {
					return c.json({ error: "No signer found for this wallet." }, 400);
				}

				signature = wrapMultiSignerSignature(signerBytes, webAuthnSignature);
			} catch {
				return c.json({
					error:
						"Missing qx/qy and we could not infer the signer on-chain. Sign again from the same device where this passkey was created.",
				}, 400);
			}
		}

		const raw = pending.userOp;
		const userOp = {
			sender: raw.sender as `0x${string}`,
			nonce: BigInt(raw.nonce as string),
			initCode: raw.initCode as Hex,
			callData: raw.callData as Hex,
			accountGasLimits: raw.accountGasLimits as Hex,
			preVerificationGas: BigInt(raw.preVerificationGas as string),
			gasFees: raw.gasFees as Hex,
			paymasterAndData: raw.paymasterAndData as Hex,
			signature,
		};

		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const walletClient = createWalletClient({
			chain: activeChain,
			transport: http(c.env.RPC_URL),
			account: serverAccount,
		});

		const txHash = await walletClient.writeContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "handleOps",
			args: [[userOp], serverAccount.address],
		});

		const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
		if (receipt.status === "reverted") return c.json({ error: "Transaction reverted" }, 500);

		if (credentialId) {
			await saveUser(c.env, {
				uid: user.sub,
				credentialId,
			});
		}

		const createdAt = new Date().toISOString();
		const isAccountAction = pending.currency === "PASSKEY_ADD";

		if (!isAccountAction) {
			await recordSentTransaction(c.env, {
				uid: user.sub,
				txHash,
				amount: pending.amount || "0",
				currency: pending.currency || "USDC",
				to: pending.wallet || "",
				createdAt,
			});
		}

		const linkId = pending.linkId;
		if (!isAccountAction && isStoredPaymentLink(linkId)) {
			const link = await getPaymentLinkById(c.env, linkId);
			if (link) {
				await markPaymentLinkPaid(c.env, {
					id: linkId,
					amount: pending.amount || link.amount,
					txHash,
					paidAt: createdAt,
					paidBy: pending.senderAddress || "",
				});
			}
		}

		await deletePendingPayment(c.env, userOpHash);
		return c.json({ status: "success", txHash });
	} catch (error) {
		console.error("Submit error:", error);
		const msg = String(error);
		if (msg.includes("AA24")) return c.json({ error: "Error de firma: esta passkey no coincide con tu wallet." }, 500);
		if (msg.includes("AA21")) return c.json({ error: "Tu wallet no tiene fondos suficientes para cubrir el gas." }, 500);
		return c.json({ error: "Error al procesar el pago. Intenta de nuevo." }, 500);
	}
});

export default payRoutes;
