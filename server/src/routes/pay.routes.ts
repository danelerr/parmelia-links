import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	type Hex,
	encodeFunctionData,
	encodeAbiParameters,
	parseAbiParameters,
	encodePacked,
	pad,
	formatEther,
	formatUnits,
	parseUnits,
	parseEther,
} from "viem";
import {
	accountWebAuthnV2Abi,
	entryPointAbi,
	erc20Abi,
	getNetworkConfig,
	getTokenBySymbol,
	ERR,
} from "../../../shared";
import {
	createPendingPayment,
	deletePendingPayment,
	getPasskey,
	getPaymentLinkById,
	getPendingPayment,
	getUserByUid,
	getUserByWallet,
	markPaymentLinkPaid,
	markPaymentIntentPaid,
	getMerchantById,
	getPaymentIntentByLinkId,
	savePasskey,
	saveUser,
	updateSwapQuoteStatus,
	writeLedgerEntries,
	type LedgerEntry,
} from "../services/storage";
import { notifyUser } from "../services/push";
import { deliverPendingWebhooks, emitEvent } from "../services/webhooks";
import {
	PAYMASTER_POST_OP_GAS_LIMIT,
	PAYMASTER_VERIFICATION_GAS_LIMIT,
} from "../services/paymaster";
import {
	DEFAULT_CALL_GAS_LIMIT,
	DEFAULT_PRE_VERIFICATION_GAS,
	DEFAULT_VERIFICATION_GAS_LIMIT,
	buildSponsoredUserOp,
	normalizeLowS,
	serializeBigInts,
} from "../services/userOp";
import {
	isStoredPaymentLink,
	normalizeCurrency,
	normalizePositiveAmount,
	normalizeWalletAddress,
} from "../services/validation";
import { getClients, waitForTx } from "../services/clients";
import { extractErrorMessage, getRequestId, logError, logInfo, logWarn } from "../services/logger";

const payRoutes = new Hono<AppContext>();

// Pending ops that are account/DeFi actions rather than payments: they reuse
// the same sign+submit pipeline but must not be recorded as transfers.
const NON_PAYMENT_CURRENCIES = new Set(["PASSKEY_ADD", "SWAP"]);

// Gas budget for the relayer's handleOps transaction (mirrors the UserOp gas budget
// produced by buildSponsoredUserOp, plus the paymaster limits and tx overhead).
const HANDLE_OPS_TX_GAS_OVERHEAD = 300000n;
const HANDLE_OPS_TX_GAS_LIMIT =
	DEFAULT_VERIFICATION_GAS_LIMIT +
	DEFAULT_CALL_GAS_LIMIT +
	DEFAULT_PRE_VERIFICATION_GAS +
	PAYMASTER_VERIFICATION_GAS_LIMIT +
	PAYMASTER_POST_OP_GAS_LIMIT +
	HANDLE_OPS_TX_GAS_OVERHEAD;

/**
 * Derive the relayer tx gas limit from the stored op itself, so ops with a
 * larger call budget (e.g. swaps) are not strangled by the default constant.
 * accountGasLimits packs verificationGas (16 bytes) | callGas (16 bytes).
 */
function handleOpsGasFor(raw: Record<string, unknown>): bigint {
	try {
		const packed = String(raw.accountGasLimits);
		const verification = BigInt("0x" + packed.slice(2, 34));
		const call = BigInt("0x" + packed.slice(34, 66));
		const preVerification = BigInt(String(raw.preVerificationGas));
		return (
			verification +
			call +
			preVerification +
			PAYMASTER_VERIFICATION_GAS_LIMIT +
			PAYMASTER_POST_OP_GAS_LIMIT +
			HANDLE_OPS_TX_GAS_OVERHEAD
		);
	} catch {
		return HANDLE_OPS_TX_GAS_LIMIT;
	}
}

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

function wrapMultiSignerSignature(signer: Hex, webAuthnSignature: Hex): Hex {
	return encodeAbiParameters(
		parseAbiParameters("bytes[] signers, bytes[] signatures"),
		[[signer], [webAuthnSignature]],
	);
}

payRoutes.post("/prepare", requireAuth, async (c) => {
	const requestId = getRequestId((name) => c.req.header(name));
	try {
		const user = c.get("user")!;
		const body = (await c.req.json()) as Record<string, unknown>;
		const linkId = body.linkId;
		logInfo("payment_prepare_started", {
			requestId,
			uid: user.sub,
			linkId: typeof linkId === "string" ? linkId : null,
		});

		const profile = await getUserByUid(c.env, user.sub);
		const senderAddress = profile?.walletAddress ?? undefined;
		if (!senderAddress) {
			logWarn("payment_prepare_missing_wallet", { requestId, uid: user.sub });
			return c.json({ error: "You need a wallet to pay. Create one first.", error_code: ERR.NO_WALLET, requestId }, 400);
		}

		const credentialId = profile?.credentialId ?? null;
		const network = getNetworkConfig(c.env.CHAIN_KEY);
		const allowedCurrencies = network.tokens.length
			? network.tokens.map((t) => t.symbol)
			: ["USDC", "ETH"];
		const { publicClient } = getClients(c.env);

		let recipientAddress: `0x${string}` | null = null;
		let paymentAmount: string | null = null;
		let paymentCurrency: string | null = null;
		let pendingLinkId: string | null = typeof linkId === "string" ? linkId : null;

		if (isStoredPaymentLink(linkId)) {
			const link = await getPaymentLinkById(c.env, linkId);
			if (!link) {
				logWarn("payment_prepare_link_not_found", { requestId, uid: user.sub, linkId });
				return c.json({ error: "Link de pago no encontrado", error_code: ERR.LINK_NOT_FOUND, requestId }, 404);
			}
			if (link.status === "paid") {
				logWarn("payment_prepare_link_already_paid", { requestId, uid: user.sub, linkId });
				return c.json({ error: "Este link ya fue pagado", error_code: ERR.LINK_ALREADY_PAID, requestId }, 409);
			}

			recipientAddress = normalizeWalletAddress(link.wallet);
			paymentCurrency = normalizeCurrency(link.currency, allowedCurrencies) ?? "USDC";
			paymentAmount = Number(link.amount) > 0 ? link.amount : normalizePositiveAmount(body.amount);
		} else {
			recipientAddress = normalizeWalletAddress(body.wallet);
			paymentCurrency = normalizeCurrency(body.currency, allowedCurrencies);
			paymentAmount = normalizePositiveAmount(body.amount);
			// Client-side payment IDs like "manual", "direct", "username" are NOT
			// real payment_links rows, so they must be stored as NULL to avoid
			// a FOREIGN KEY constraint violation on pending_payments.link_id.
			pendingLinkId = null;
		}

		if (!recipientAddress) {
			logWarn("payment_prepare_invalid_recipient", { requestId, uid: user.sub });
			return c.json({ error: "Wallet inválida", error_code: ERR.INVALID_WALLET, requestId }, 400);
		}
		if (!paymentCurrency) {
			logWarn("payment_prepare_invalid_currency", { requestId, uid: user.sub });
			return c.json({ error: `Moneda no soportada (usa ${allowedCurrencies.join(", ")})`, error_code: ERR.UNSUPPORTED_CURRENCY, requestId }, 400);
		}
		if (!paymentAmount) {
			logWarn("payment_prepare_invalid_amount", { requestId, uid: user.sub, currency: paymentCurrency });
			return c.json({ error: "El monto debe ser mayor a 0", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		// Resolve the asset from the whitelist; legacy chains without a token
		// registry fall back to the USDC/native pair from `contracts`.
		const token = getTokenBySymbol(network, paymentCurrency);
		const isNative = token ? !!token.isNative : paymentCurrency === "ETH";
		const tokenAddress = token?.address ?? network.contracts.usdc;
		const tokenDecimals = token?.decimals ?? network.contracts.usdcDecimals;

		let executeCalldata: Hex;

		if (!isNative) {
			let rawAmount: bigint;
			try {
				rawAmount = parseUnits(paymentAmount, tokenDecimals);
			} catch {
				logWarn("payment_prepare_invalid_erc20_amount", { requestId, uid: user.sub, amount: paymentAmount, currency: paymentCurrency });
				return c.json({ error: `Monto inválido para ${paymentCurrency}`, error_code: ERR.INVALID_AMOUNT, requestId }, 400);
			}

			const erc20Balance = (await publicClient.readContract({
				address: tokenAddress,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [senderAddress as `0x${string}`],
			})) as bigint;
			if (erc20Balance < rawAmount) {
				logWarn("payment_prepare_insufficient_erc20", {
					requestId,
					uid: user.sub,
					wallet: senderAddress,
					balance: formatUnits(erc20Balance, tokenDecimals),
					amount: paymentAmount,
					currency: paymentCurrency,
				});
				return c.json(
					{
						error: `Saldo ${paymentCurrency} insuficiente (tienes ${formatUnits(erc20Balance, tokenDecimals)} ${paymentCurrency})`,
						error_code: ERR.INSUFFICIENT_BALANCE,
						requestId,
					},
					400,
				);
			}
			const transferData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipientAddress, rawAmount] });
			executeCalldata = buildExecuteCalldata(tokenAddress, 0n, transferData);
		} else {
			let ethAmount: bigint;
			try {
				ethAmount = parseEther(paymentAmount);
			} catch {
				logWarn("payment_prepare_invalid_native_amount", { requestId, uid: user.sub, amount: paymentAmount });
				return c.json({ error: "Monto inválido para ETH", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
			}

			const ethBalance = await publicClient.getBalance({ address: senderAddress as `0x${string}` });
			if (ethBalance < ethAmount) {
				logWarn("payment_prepare_insufficient_native", {
					requestId,
					uid: user.sub,
					wallet: senderAddress,
					balance: formatEther(ethBalance),
					amount: paymentAmount,
				});
				return c.json({
					error: `Saldo ETH insuficiente (tienes ${formatEther(ethBalance)} ETH)`,
					error_code: ERR.INSUFFICIENT_BALANCE,
					requestId,
				}, 400);
			}
			executeCalldata = buildExecuteCalldata(recipientAddress, ethAmount, "0x");
		}

		const { userOp, userOpHash, chainId } = await buildSponsoredUserOp(c.env, {
			sender: senderAddress as `0x${string}`,
			callData: executeCalldata,
		});

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

		logInfo("payment_prepare_created", {
			requestId,
			uid: user.sub,
			userOpHash,
			senderAddress,
			recipientAddress,
			amount: paymentAmount,
			currency: paymentCurrency,
			linkId: pendingLinkId,
			chainId,
		});
		return c.json({ userOpHash, credentialId });
	} catch (error) {
		const user = c.get("user");
		logError("payment_prepare_failed", error, { requestId, uid: user?.sub ?? null });
		return c.json({ error: extractErrorMessage(error) || "Error al preparar el pago.", requestId }, 500);
	}
});

payRoutes.post("/submit", requireAuth, async (c) => {
	const requestId = getRequestId((name) => c.req.header(name));
	let userOpHashForLog: string | null = null;
	try {
		const user = c.get("user")!;
		const { userOpHash, authenticatorData, clientDataJSON, r, s, credentialId, qx, qy } = await c.req.json();
		userOpHashForLog = typeof userOpHash === "string" ? userOpHash : null;
		logInfo("payment_submit_started", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			hasCredentialId: Boolean(credentialId),
			hasQxQy: Boolean(qx && qy),
		});
		if (!userOpHash || !authenticatorData || !clientDataJSON || !r || !s) {
			logWarn("payment_submit_missing_signature_data", { requestId, uid: user.sub, userOpHash: userOpHashForLog });
			return c.json({ error: "Missing signature data", requestId }, 400);
		}

		const pending = await getPendingPayment(c.env, userOpHash);
		if (!pending) {
			logWarn("payment_submit_pending_not_found", { requestId, uid: user.sub, userOpHash: userOpHashForLog });
			return c.json({ error: "No pending payment found", requestId }, 404);
		}
		if (pending.uid !== user.sub) {
			logWarn("payment_submit_unauthorized_pending", { requestId, uid: user.sub, userOpHash: userOpHashForLog });
			return c.json({ error: "Unauthorized", requestId }, 403);
		}
		logInfo("payment_submit_pending_loaded", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			senderAddress: pending.senderAddress,
			recipientAddress: pending.wallet,
			amount: pending.amount,
			currency: pending.currency,
			linkId: pending.linkId,
		});

		const { contracts } = getNetworkConfig(c.env.CHAIN_KEY);
		const { publicClient, walletClient, serverAccount } = getClients(c.env);

		const typeIndex = (clientDataJSON as string).indexOf('"type"');
		const challengeIndex = (clientDataJSON as string).indexOf('"challenge"');

		const normalizedSHex = normalizeLowS(s as string);

		// Inner signature: WebAuthn authentication assertion
		const webAuthnSignature = encodeAbiParameters(
			parseAbiParameters("bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON"),
			[r as Hex, normalizedSHex, BigInt(challengeIndex), BigInt(typeIndex), authenticatorData as Hex, clientDataJSON as string],
		);

		let signature: Hex;

		// Resolve the signer's public key (qx, qy). Prefer client-provided values; else
		// look them up in D1 by credentialId (lets a synced passkey sign on a device
		// without the local cache). On-chain inference is the last resort and only works
		// for single-signer wallets.
		let signerQx = (qx as `0x${string}` | undefined) || undefined;
		let signerQy = (qy as `0x${string}` | undefined) || undefined;
		let signerSource = signerQx && signerQy ? "client_q_coordinates" : "none";

		if ((!signerQx || !signerQy) && typeof credentialId === "string" && credentialId) {
			const stored = await getPasskey(c.env, credentialId);
			if (stored) {
				signerQx = stored.qx as `0x${string}`;
				signerQy = stored.qy as `0x${string}`;
				signerSource = "stored_passkey";
			}
		}

		if (signerQx && signerQy) {
			const signerBytes = encodePacked(
				["address", "bytes32", "bytes32"],
				[contracts.verifier, signerQx, signerQy],
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
					logWarn("payment_submit_missing_q_coordinates", {
						requestId,
						uid: user.sub,
						userOpHash: userOpHashForLog,
						signerCount: signerCount.toString(),
					});
					return c.json({
						error: "Missing qx/qy for a multi-passkey wallet. Sign again from a device that knows this passkey.",
						requestId,
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
					logWarn("payment_submit_no_onchain_signer", { requestId, uid: user.sub, userOpHash: userOpHashForLog });
					return c.json({ error: "No signer found for this wallet.", requestId }, 400);
				}

				signature = wrapMultiSignerSignature(signerBytes, webAuthnSignature);
				signerSource = "single_onchain_signer";
			} catch (error) {
				logError("payment_submit_signer_inference_failed", error, { requestId, uid: user.sub, userOpHash: userOpHashForLog });
				return c.json({
					error: "Missing qx/qy and we could not infer the signer on-chain. Sign again from the same device where this passkey was created.",
					requestId,
				}, 400);
			}
		}
		logInfo("payment_submit_signature_wrapped", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			signerSource,
		});

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

		const handleOpsGas = handleOpsGasFor(raw);
		logInfo("payment_submit_handleops_sending", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			entryPoint: contracts.entryPoint,
			relayerAddress: serverAccount.address,
			gasLimit: handleOpsGas.toString(),
		});
		try {
			await publicClient.simulateContract({
				account: serverAccount.address,
				address: contracts.entryPoint,
				abi: entryPointAbi,
				functionName: "handleOps",
				args: [[userOp], serverAccount.address],
				gas: handleOpsGas,
			});
			logInfo("payment_submit_handleops_simulation_ok", {
				requestId,
				uid: user.sub,
				userOpHash: userOpHashForLog,
				gasLimit: handleOpsGas.toString(),
			});
		} catch (error) {
			logError("payment_submit_handleops_simulation_failed", error, {
				requestId,
				uid: user.sub,
				userOpHash: userOpHashForLog,
				gasLimit: handleOpsGas.toString(),
			});
			throw error;
		}
		const txHash = await walletClient.writeContract({
			address: contracts.entryPoint,
			abi: entryPointAbi,
			functionName: "handleOps",
			args: [[userOp], serverAccount.address],
			gas: handleOpsGas,
		});

		logInfo("payment_submit_handleops_sent", { requestId, uid: user.sub, userOpHash: userOpHashForLog, txHash });
		const receipt = await waitForTx(publicClient, txHash);
		logInfo("payment_submit_receipt", { requestId, uid: user.sub, userOpHash: userOpHashForLog, txHash, receiptStatus: receipt.status });
		if (receipt.status === "reverted") {
			logError("payment_submit_receipt_reverted", new Error("handleOps transaction reverted"), {
				requestId,
				uid: user.sub,
				userOpHash: userOpHashForLog,
				txHash,
			});
			return c.json({ error: "Transaction reverted", error_code: ERR.TX_REVERTED, requestId, txHash }, 500);
		}

		if (credentialId) {
			await saveUser(c.env, { uid: user.sub, credentialId });
			// Persist the public key so any device (even one without the local cache)
			// can resolve this signer next time.
			if (signerQx && signerQy) {
				await savePasskey(c.env, { credentialId, uid: user.sub, qx: signerQx, qy: signerQy });
			}
		}

		const createdAt = new Date().toISOString();
		const isAccountAction = NON_PAYMENT_CURRENCIES.has(pending.currency);
		const linkId = pending.linkId;
		let linkReference: string | null = null;

		if (!isAccountAction && isStoredPaymentLink(linkId)) {
			const link = await getPaymentLinkById(c.env, linkId);
			if (link) {
				linkReference = link.reference || null;
				await markPaymentLinkPaid(c.env, {
					id: linkId,
					amount: pending.amount || link.amount,
					txHash,
					paidAt: createdAt,
					paidBy: pending.senderAddress || "",
				});

				// If this link backs an API payment intent, settle it and fire the
				// payment.paid webhook (flushed after the response via waitUntil).
				const intent = await getPaymentIntentByLinkId(c.env, linkId);
				if (intent && intent.status === "awaiting_payment") {
					await markPaymentIntentPaid(c.env, intent.id, txHash, createdAt);
					const merchant = await getMerchantById(c.env, intent.merchantId);
					if (merchant) {
						const flush = (async () => {
							await emitEvent(c.env, {
								merchantId: intent.merchantId,
								mode: intent.mode,
								type: "payment.paid",
								objectId: intent.id,
								data: {
									id: intent.id,
									object: "payment_intent",
									status: "paid",
									amount: intent.amount,
									currency: intent.currency,
									reference: intent.reference,
									metadata: intent.metadata ?? {},
									tx_hash: txHash,
									mode: intent.mode,
								},
							});
							await deliverPendingWebhooks(c.env);
						})();
						try {
							c.executionCtx.waitUntil(flush);
						} catch {
							void flush;
						}
					}
				}
			}
		}

		// Ledger writes - the app is the source of truth for everything it relays:
		// the payer always gets an "out" row, and if the recipient is a Parmelia
		// user they get their "in" row immediately (no chain scanning needed).
		if (pending.currency === "SWAP") {
			const meta = pending.meta ?? {};
			const swapEntries: LedgerEntry[] = [];
			if (typeof meta.tokenIn === "string" && typeof meta.amountIn === "string") {
				swapEntries.push({
					uid: user.sub,
					direction: "out" as const,
					kind: "swap" as const,
					txHash,
					token: meta.tokenIn,
					amount: meta.amountIn,
					counterparty: pending.senderAddress,
					reference: typeof meta.tokenOut === "string" ? `Cambio a ${meta.tokenOut}` : null,
					createdAt,
				});
			}
			if (typeof meta.tokenOut === "string" && typeof meta.amountOutEstimated === "string") {
				swapEntries.push({
					uid: user.sub,
					direction: "in" as const,
					kind: "swap" as const,
					txHash,
					token: meta.tokenOut,
					// Estimate at quote time; TODO: refine from receipt logs later.
					amount: meta.amountOutEstimated,
					counterparty: pending.senderAddress,
					reference: typeof meta.tokenIn === "string" ? `Cambio desde ${meta.tokenIn}` : null,
					createdAt,
				});
			}
			if (swapEntries.length > 0) await writeLedgerEntries(c.env, swapEntries);
			if (typeof meta.quoteId === "string") {
				await updateSwapQuoteStatus(c.env, meta.quoteId, "executed");
			}
		} else if (!isAccountAction) {
			const recipient = await getUserByWallet(c.env, pending.wallet || "");
			const entries: LedgerEntry[] = [
				{
					uid: user.sub,
					direction: "out",
					kind: "payment",
					txHash,
					token: pending.currency || "USDC",
					amount: pending.amount || "0",
					counterparty: pending.wallet || null,
					counterpartyUid: recipient?.uid ?? null,
					reference: linkReference,
					linkId: isStoredPaymentLink(linkId) ? linkId : null,
					createdAt,
				},
			];
			if (recipient && recipient.uid !== user.sub) {
				entries.push({
					uid: recipient.uid,
					direction: "in",
					kind: isStoredPaymentLink(linkId) ? "link" : "payment",
					txHash,
					token: pending.currency || "USDC",
					amount: pending.amount || "0",
					counterparty: pending.senderAddress || null,
					counterpartyUid: user.sub,
					reference: linkReference,
					linkId: isStoredPaymentLink(linkId) ? linkId : null,
					createdAt,
				});
			}
			await writeLedgerEntries(c.env, entries);

			// Best-effort "te pagaron" push to the recipient (never blocks the response).
			if (recipient && recipient.uid !== user.sub) {
				const note = {
					title: "Te pagaron",
					body: `Recibiste ${pending.amount} ${pending.currency}`,
					link: "/",
				};
				try {
					c.executionCtx.waitUntil(notifyUser(c.env, recipient.uid, note));
				} catch {
					void notifyUser(c.env, recipient.uid, note);
				}
			}
		}

		await deletePendingPayment(c.env, userOpHash);
		logInfo("payment_submit_success", { requestId, uid: user.sub, userOpHash: userOpHashForLog, txHash });
		return c.json({ status: "success", txHash });
	} catch (error) {
		const msg = extractErrorMessage(error);
		const user = c.get("user");
		logError("payment_submit_failed", error, {
			requestId,
			uid: user?.sub ?? null,
			userOpHash: userOpHashForLog,
		});
		if (msg.includes("AA24")) return c.json({ error: "Error de firma: esta passkey no coincide con tu wallet.", error_code: ERR.PASSKEY_MISMATCH, requestId }, 500);
		if (msg.includes("AA21")) return c.json({ error: "Tu wallet no tiene fondos suficientes para cubrir el gas.", error_code: ERR.INSUFFICIENT_GAS, requestId }, 500);
		if (msg.includes("AA95")) return c.json({ error: "La transaccion de handleOps no tenia gas suficiente. Revisa el gas limit del relayer.", error_code: ERR.INSUFFICIENT_GAS, requestId }, 500);
		if (msg.includes("InvalidPaymasterSignature") || msg.includes("AA33") || msg.includes("AA34")) {
			return c.json({
				error: "El paymaster rechazo la operacion. Revisa sponsorSigner on-chain, PAYMASTER_SIGNER_PRIVATE_KEY y el deposito del paymaster.",
				requestId,
			}, 500);
		}
		if (msg.includes("AA31") || msg.toLowerCase().includes("deposit too low")) {
			return c.json({ error: "El paymaster no tiene deposito suficiente para patrocinar el gas en EntryPoint.", requestId }, 500);
		}
		if (msg.includes("FailedOp")) {
			return c.json({ error: msg, requestId }, 500);
		}
		return c.json({ error: msg || "Error al procesar el pago. Intenta de nuevo.", error_code: ERR.PAYMENT_FAILED, requestId }, 500);
	}
});

export default payRoutes;
