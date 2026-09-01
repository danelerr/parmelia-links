import { Hono, type Context } from "hono";
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
	erc20Abi,
	paymentRouterV2Abi,
	getNetworkConfig,
	getTokenBySymbol,
	isSupportedChainKey,
	ERR,
} from "../../../shared";
import {
	claimPendingForSubmit,
	claimPaymentLinkForSubmit,
	createPendingPayment,
	getPasskey,
	getPaymentLinkById,
	getPendingPayment,
	getUserChainAccount,
	getPendingPaymentAnyState,
	getUserByUid,
	isIntentPayable,
	getPaymentIntentByLinkId,
	markPaymentLinkClaimBroadcast,
	releasePaymentLinkClaim,
	releasePendingClaim,
	savePasskey,
	saveUser,
	setPendingPaymentSubmitted,
	updateCrosschainOp,
} from "../services/storage";
import { reserveAppPaymentAttempt, wakePaymentsSync } from "../services/paymentsRpc";
import type { ReservedAppPaymentAttempt } from "../../../shared/paymentContracts";
import { NON_PAYMENT_CURRENCIES } from "../services/settlement";
import {
	buildSponsoredUserOp,
	matchOnchainSigner,
	normalizeLowS,
	serializeBigInts,
} from "../services/userOp";
import {
	isStoredPaymentLink,
	normalizeCurrency,
	normalizePositiveAmount,
	normalizeWalletAddress,
} from "../services/validation";
import { getClients } from "../services/clients";
import { extractErrorMessage, logError, logInfo, logWarn } from "../services/logger";
import {
	paymentLinkPrepareAction,
	paymentSubmissionBlocked,
	paymentsCutoverState,
} from "../services/paymentsCutover";
import { SignerLeaseBusyError } from "../services/signerLease";
import {
	getUserOperationTransport,
	selectUserOperationTransport,
	sendUserOperation,
	UserOperationTransportError,
} from "../services/userOperationTransport";
import { bindingsForChain, resolveAppChainKey } from "../services/chainScope";

const payRoutes = new Hono<AppContext>();

function buildExecuteCalldata(target: `0x${string}`, value: bigint, data: Hex): Hex {
	return buildExecuteBatchCalldata([{ target, value, callData: data }]);
}

function buildExecuteBatchCalldata(executions: Array<{ target: `0x${string}`; value: bigint; callData: Hex }>): Hex {
	const mode = pad("0x01", { size: 32, dir: "right" }) as Hex;
	const executionData = encodeAbiParameters(
		parseAbiParameters("(address target, uint256 value, bytes callData)[]"),
		[executions],
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

function cutoverUnavailable(c: Context<AppContext>, requestId: string) {
	const cutover = paymentsCutoverState(c.env);
	c.header("Cache-Control", "no-store");
	c.header("Retry-After", "60");
	return c.json({
		error: "Payment writes are temporarily frozen for a controlled migration",
		error_code: ERR.SERVICE_UNAVAILABLE,
		requestId,
		payments_cutover_mode: cutover.mode,
		retryable: true,
	}, 503);
}

payRoutes.post("/prepare", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const user = c.get("user")!;
		const body = (await c.req.json()) as Record<string, unknown>;
		const linkId = body.linkId;
		logInfo("payment_prepare_started", {
			requestId,
			uid: user.sub,
			linkId: typeof linkId === "string" ? linkId : null,
		});
		const storedPaymentLink = isStoredPaymentLink(linkId);
		const prepareAction = storedPaymentLink
			? paymentLinkPrepareAction(paymentsCutoverState(c.env).mode)
			: null;
		if (prepareAction === "block") return cutoverUnavailable(c, requestId);

		const profile = await getUserByUid(c.env, user.sub);
		const requestedChainKey = storedPaymentLink ? c.env.CHAIN_KEY : body.chainKey;
		const chainKey = resolveAppChainKey(c.env, requestedChainKey, { requireWalletRail: true });
		if (!chainKey) {
			return c.json({ error: "Red no soportada", error_code: ERR.UNSUPPORTED_CHAIN, requestId }, 400);
		}
		const paymentEnv = bindingsForChain(c.env, chainKey);
		const network = getNetworkConfig(chainKey);
		const chainAccount = await getUserChainAccount(c.env, user.sub, network.chainId);
		const senderAddress = chainKey === c.env.CHAIN_KEY
			? profile?.walletAddress ?? undefined
			: chainAccount?.status === "active" && chainAccount.securityStatus === "current"
				? chainAccount.walletAddress
				: undefined;
		if (!senderAddress) {
			logWarn("payment_prepare_missing_wallet", { requestId, uid: user.sub });
			return c.json({ error: "You need a wallet to pay. Create one first.", error_code: ERR.NO_WALLET, requestId }, 400);
		}

		const credentialId = profile?.credentialId ?? null;
		const submissionTransport = selectUserOperationTransport(paymentEnv, user.sub);
		const allowedCurrencies = network.tokens.length
			? network.tokens.map((t) => t.symbol)
			: ["USDC", "ETH"];
		const { publicClient } = getClients(paymentEnv);

		let recipientAddress: `0x${string}` | null = null;
		let paymentAmount: string | null = null;
		let paymentCurrency: string | null = null;
		let pendingLinkId: string | null = typeof linkId === "string" ? linkId : null;
		let paymentAttempt: ReservedAppPaymentAttempt | null = null;

		if (storedPaymentLink) {
			if (prepareAction === "payments") {
				const reservation = await reserveAppPaymentAttempt(paymentEnv, {
					commandId: `prepare:${user.sub}:${linkId}:${c.req.header("Idempotency-Key")?.trim() || (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "active")}`,
					requestId,
					uid: user.sub,
					linkId,
					payerAddress: senderAddress,
					amount: typeof body.amount === "string" ? body.amount : undefined,
				});
				if (!reservation.ok) {
					const status = reservation.error === "NOT_FOUND" ? 404 : reservation.error === "UNAVAILABLE" ? 503 : 409;
					const code = reservation.error === "NOT_FOUND" ? ERR.LINK_NOT_FOUND : reservation.error === "UNAVAILABLE" ? ERR.SERVICE_UNAVAILABLE : ERR.PAYMENT_IN_PROGRESS;
					return c.json({ error: reservation.message, error_code: code, requestId }, status);
				}
				paymentAttempt = reservation.value;
				recipientAddress = normalizeWalletAddress(paymentAttempt.merchant);
				paymentCurrency = paymentAttempt.currency;
				paymentAmount = paymentAttempt.amount;
				pendingLinkId = null;
			} else {
				const link = await getPaymentLinkById(c.env, linkId);
				if (!link) {
					logWarn("payment_prepare_link_not_found", { requestId, uid: user.sub, linkId });
					return c.json({ error: "Link de pago no encontrado", error_code: ERR.LINK_NOT_FOUND, requestId }, 404);
				}
				if (link.status === "paid") {
					logWarn("payment_prepare_link_already_paid", { requestId, uid: user.sub, linkId });
					return c.json({ error: "Este link ya fue pagado", error_code: ERR.LINK_ALREADY_PAID, requestId }, 409);
				}
				const backingIntent = await getPaymentIntentByLinkId(c.env, linkId);
				if (backingIntent && !isIntentPayable(backingIntent)) {
					logWarn("payment_prepare_intent_not_payable", { requestId, uid: user.sub, linkId, intentStatus: backingIntent.status });
					return c.json({ error: "Este cobro ya no está disponible", error_code: ERR.INTENT_NOT_PAYABLE, requestId }, 409);
				}
				recipientAddress = normalizeWalletAddress(link.wallet);
				paymentCurrency = normalizeCurrency(link.currency, allowedCurrencies) ?? "USDC";
				paymentAmount = Number(link.amount) > 0 ? link.amount : normalizePositiveAmount(body.amount);
			}
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
			if (paymentAttempt) {
				const authorization = paymentAttempt.authorization;
				const totalPayerAmount = BigInt(authorization.settlementAmount) + BigInt(authorization.platformFee);
				if (erc20Balance < totalPayerAmount) {
					return c.json({ error: `Saldo ${paymentCurrency} insuficiente`, error_code: ERR.INSUFFICIENT_BALANCE, requestId }, 400);
				}
				const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [paymentAttempt.router, totalPayerAmount] });
				const payData = encodeFunctionData({
					abi: paymentRouterV2Abi,
					functionName: "pay",
					args: [{
						intentId: authorization.intentId,
						attemptId: authorization.attemptId,
						payer: authorization.payer,
						merchant: authorization.merchant,
						settlementAmount: BigInt(authorization.settlementAmount),
						platformFee: BigInt(authorization.platformFee),
						validAfter: authorization.validAfter,
						validUntil: authorization.validUntil,
						metadataHash: authorization.metadataHash,
					}, paymentAttempt.signature],
				});
				executeCalldata = buildExecuteBatchCalldata([
					{ target: tokenAddress, value: 0n, callData: approveData },
					{ target: paymentAttempt.router, value: 0n, callData: payData },
				]);
			} else {
				const transferData = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipientAddress, rawAmount] });
				executeCalldata = buildExecuteCalldata(tokenAddress, 0n, transferData);
			}
		} else {
			let ethAmount: bigint;
			try {
				ethAmount = parseEther(paymentAmount);
			} catch {
				logWarn("payment_prepare_invalid_native_amount", { requestId, uid: user.sub, amount: paymentAmount });
				return c.json({ error: `Monto inválido para ${network.nativeTokenSymbol}`, error_code: ERR.INVALID_AMOUNT, requestId }, 400);
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
					error: `Saldo ${network.nativeTokenSymbol} insuficiente (tienes ${formatEther(ethBalance)} ${network.nativeTokenSymbol})`,
					error_code: ERR.INSUFFICIENT_BALANCE,
					requestId,
				}, 400);
			}
			executeCalldata = buildExecuteCalldata(recipientAddress, ethAmount, "0x");
		}

		const { userOp, userOpHash, chainId, rpId, signingPayload, sponsorshipProvider,
			sponsorshipPaymasterAddress } = await buildSponsoredUserOp(paymentEnv, {
			sender: senderAddress as `0x${string}`,
			callData: executeCalldata,
			transportMode: submissionTransport,
		});

		await createPendingPayment(paymentEnv, {
			userOpHash,
			chainId: network.chainId,
			chainKey: network.key,
			linkId: pendingLinkId,
			paymentAttemptId: paymentAttempt?.attemptId ?? null,
			uid: user.sub,
			amount: paymentAmount,
			currency: paymentCurrency,
			wallet: recipientAddress,
			senderAddress,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
			meta: paymentAttempt ? {
				paymentAttemptId: paymentAttempt.attemptId,
				paymentIntentId: paymentAttempt.intentId,
				paymentLinkId: paymentAttempt.linkId,
			} : null,
			submissionTransport,
			sponsorshipProvider,
			sponsorshipPaymasterAddress,
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
			submissionTransport,
			sponsorshipProvider,
		});
		return c.json({ userOpHash, credentialId, rpId, submissionTransport, signingPayload,
			paymentAttemptId: paymentAttempt?.attemptId });
	} catch (error) {
		const user = c.get("user");
		logError("payment_prepare_failed", error, { requestId, uid: user?.sub ?? null });
		return c.json({ error: extractErrorMessage(error) || "Error al preparar el pago.", error_code: ERR.SERVER_ERROR, requestId }, 500);
	}
});

payRoutes.post("/submit", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	let userOpHashForLog: string | null = null;
	// Lifecycle trackers for the catch block: a claimed-but-never-broadcast
	// payment is released for retry; a broadcast one is left to the reconciler.
	let claimed = false;
	let claimedLinkId: string | null = null;
	let broadcastTxHash: string | null = null;
	let submissionAccepted = false;
	let operationEnv: AppContext["Bindings"] = c.env;
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
			return c.json({ error: "Missing signature data", error_code: ERR.MISSING_SIGNATURE_DATA, requestId }, 400);
		}

		const pending = await getPendingPayment(c.env, userOpHash);
		if (!pending) {
			logWarn("payment_submit_pending_not_found", { requestId, uid: user.sub, userOpHash: userOpHashForLog });
			return c.json({ error: "No pending payment found", error_code: ERR.PENDING_NOT_FOUND, requestId }, 404);
		}
		if (pending.uid !== user.sub) {
			logWarn("payment_submit_unauthorized_pending", { requestId, uid: user.sub, userOpHash: userOpHashForLog });
			return c.json({ error: "Unauthorized", error_code: ERR.WRONG_ACCOUNT, requestId }, 403);
		}
		if (isSupportedChainKey(pending.chainKey)) {
			operationEnv = bindingsForChain(c.env, pending.chainKey);
		}
		const cutover = paymentsCutoverState(operationEnv);
		if (paymentSubmissionBlocked({
			mode: cutover.mode,
			hasLegacyLink: isStoredPaymentLink(pending.linkId),
			hasPaymentAttempt: Boolean(pending.paymentAttemptId),
		})) {
			logWarn("payment_submit_cutover_blocked", {
				requestId,
				uid: user.sub,
				userOpHash: userOpHashForLog,
				mode: cutover.mode,
				legacyLinkId: isStoredPaymentLink(pending.linkId) ? pending.linkId : null,
				paymentAttemptId: pending.paymentAttemptId,
			});
			return cutoverUnavailable(c, requestId);
		}

		// Narrow the double-payment window: re-check the link (and any backing
		// intent) at submit time, not just at prepare. The post-chain atomic
		// settlement guard is the last line of defense; this check stops the
		// second payer BEFORE their funds move on-chain.
		if (!NON_PAYMENT_CURRENCIES.has(pending.currency) && isStoredPaymentLink(pending.linkId)) {
			const linkNow = await getPaymentLinkById(operationEnv, pending.linkId);
			if (linkNow?.status === "paid") {
				logWarn("payment_submit_link_already_paid", { requestId, uid: user.sub, linkId: pending.linkId });
				return c.json({ error: "Este link ya fue pagado", error_code: ERR.LINK_ALREADY_PAID, requestId }, 409);
			}
			const intentNow = await getPaymentIntentByLinkId(operationEnv, pending.linkId);
			if (intentNow && !isIntentPayable(intentNow)) {
				logWarn("payment_submit_intent_not_payable", { requestId, uid: user.sub, linkId: pending.linkId, intentStatus: intentNow.status });
				return c.json({ error: "Este cobro ya no está disponible", error_code: ERR.INTENT_NOT_PAYABLE, requestId }, 409);
			}
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

		const network = getNetworkConfig(operationEnv.CHAIN_KEY);
		const { contracts } = network;
		const { publicClient } = getClients(operationEnv);

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
			const stored = await getPasskey(operationEnv, credentialId);
			if (stored) {
				signerQx = stored.qx as `0x${string}`;
				signerQy = stored.qy as `0x${string}`;
				signerSource = "stored_passkey";
			}
		}

		if (signerQx && signerQy) {
			// Resolve the signer bytes REGISTERED on the account (they embed the
			// verifier address of their generation); rebuilding from the current
			// network verifier would break accounts created before a verifier
			// redeploy. Reconstruction stays only as a fallback for RPC blips.
			let signerBytes = encodePacked(
				["address", "bytes32", "bytes32"],
				[contracts.verifier, signerQx, signerQy],
			);
			try {
				const onchainSigners = (await publicClient.readContract({
					address: pending.senderAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "getSigners",
					args: [0, 32],
				})) as Hex[];
				const registered = matchOnchainSigner(onchainSigners, signerQx, signerQy);
				if (registered) {
					if (registered.toLowerCase() !== signerBytes.toLowerCase()) {
						signerSource = `${signerSource}+onchain_verifier`;
					}
					signerBytes = registered;
				}
			} catch (error) {
				logWarn("payment_submit_signer_lookup_failed", {
					requestId,
					uid: user.sub,
					userOpHash: userOpHashForLog,
					error: extractErrorMessage(error),
				});
			}
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
						error_code: ERR.MISSING_PASSKEY_DATA,
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
					return c.json({ error: "No signer found for this wallet.", error_code: ERR.MISSING_PASSKEY_DATA, requestId }, 400);
				}

				signature = wrapMultiSignerSignature(signerBytes, webAuthnSignature);
				signerSource = "single_onchain_signer";
			} catch (error) {
				logError("payment_submit_signer_inference_failed", error, { requestId, uid: user.sub, userOpHash: userOpHashForLog });
				return c.json({
					error: "Missing qx/qy and we could not infer the signer on-chain. Sign again from the same device where this passkey was created.",
					error_code: ERR.MISSING_PASSKEY_DATA,
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

		// Atomic claim: exactly one submit of this userOpHash proceeds past here.
		// A duplicate (double-tap, retried request) gets a clean 409 instead of
		// re-broadcasting and burning relayer gas on a guaranteed nonce revert.
		if (!(await claimPendingForSubmit(operationEnv, userOpHash))) {
			const current = await getPendingPaymentAnyState(operationEnv, userOpHash);
			logWarn("payment_submit_duplicate", { requestId, uid: user.sub, userOpHash: userOpHashForLog, status: current?.status });
			return c.json(
				{
					error: "Este pago ya está en proceso.",
					error_code: ERR.PAYMENT_IN_PROGRESS,
					status: current?.status ?? "unknown",
					txHash: current?.submittedTxHash ?? undefined,
					requestId,
				},
				409,
			);
		}
		claimed = true;

		if (!NON_PAYMENT_CURRENCIES.has(pending.currency) && isStoredPaymentLink(pending.linkId)) {
			const claimExpiresAt = new Date(
				Math.max(new Date(pending.expiresAt).getTime(), Date.now() + 15 * 60_000),
			).toISOString();
			if (!(await claimPaymentLinkForSubmit(operationEnv, pending.linkId, userOpHash, claimExpiresAt))) {
				await releasePendingClaim(operationEnv, userOpHash);
				claimed = false;
				return c.json({
					error: "Este link ya tiene un pago en proceso.",
					error_code: ERR.PAYMENT_IN_PROGRESS,
					requestId,
				}, 409);
			}
			claimedLinkId = pending.linkId;
		}

		logInfo("payment_submit_transport_sending", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			transport: pending.submissionTransport,
		});
		const submission = await sendUserOperation(operationEnv, pending.submissionTransport, {
			userOp,
			userOpHash: userOpHash as Hex,
			entryPoint: contracts.entryPoint,
		});
		submissionAccepted = true;
		broadcastTxHash = submission.transactionHash;
		logInfo("payment_submit_transport_accepted", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			transport: submission.transport,
			hasTransactionHash: Boolean(submission.transactionHash),
		});
		// Persist the authoritative payment hand-off first. If a later auxiliary
		// write fails, the reconciler has the exact transaction fast path.
		await setPendingPaymentSubmitted(
			operationEnv,
			userOpHash,
			submission.transport,
			submission.transactionHash,
		);
		if (pending.paymentAttemptId) {
			await wakePaymentsSync(operationEnv, "payment_execution_submitted").catch((error) =>
				logError("payments_execution_wakeup_failed", error, { requestId, userOpHash }),
			);
		}
		if (claimedLinkId) {
			// Bundlers return the stable UserOperation hash, not a bundle tx hash.
			// Either value proves the claim was handed off and must not expire.
			await markPaymentLinkClaimBroadcast(
				operationEnv,
				claimedLinkId,
				userOpHash,
				submission.transactionHash ?? submission.userOpHash,
			);
		}

		// Cross-chain: attach the burn tx to its op (created at /crosschain/prepare,
		// status 'quoted') for the same crash-safety reason (CROSSCHAIN_DESIGN
		// §"register before signing").
		const crosschainOpId =
			pending.currency === "CROSSCHAIN" && typeof pending.meta?.opId === "string" ? pending.meta.opId : null;
		if (crosschainOpId && submission.transactionHash) {
			await updateCrosschainOp(
				operationEnv,
				crosschainOpId,
				{
					status: "submitted",
					sourceTxHash: submission.transactionHash,
				},
				{ ifStatusIn: ["quoted", "submitted"] },
			);
		}

		// Persist the credential hint while this request still has the assertion
		// context. This is independent of the transaction outcome; the signature
		// and on-chain signer match were validated before broadcast.
		if (credentialId) {
			try {
				await saveUser(operationEnv, { uid: user.sub, credentialId });
				if (signerQx && signerQy) {
					await savePasskey(operationEnv, { credentialId, uid: user.sub, qx: signerQx, qy: signerQy });
				}
			} catch (error) {
				logError("payment_submit_passkey_persist_failed", error, {
					requestId,
					uid: user.sub,
					userOpHash: userOpHashForLog,
				});
			}
		}

		// Do not hold a Worker request open for a receipt. The persisted
		// `submitted` row is the durable hand-off to runPaymentReconciler, which
		// verifies both the transaction receipt and UserOperationEvent(success),
		// then performs idempotent accounting and outbox settlement.
		logInfo("payment_submit_accepted", {
			requestId,
			uid: user.sub,
			userOpHash: userOpHashForLog,
			transport: submission.transport,
			hasTransactionHash: Boolean(submission.transactionHash),
		});
		return c.json(
			{
				status: "pending",
				txHash: submission.transactionHash ?? undefined,
				userOpHash,
				transport: submission.transport,
				requestId,
			},
			202,
		);
	} catch (error) {
		const msg = extractErrorMessage(error);
		const user = c.get("user");
		logError("payment_submit_failed", error, {
			requestId,
			uid: user?.sub ?? null,
			userOpHash: userOpHashForLog,
		});

		// A timeout can occur after a node/bundler accepted the request. Treating
		// that as "not sent" would release a payment link while funds may still
		// move. Keep the durable claim and let the universal watcher resolve the
		// UserOperation by hash.
		if (
			error instanceof UserOperationTransportError &&
			error.possiblySubmitted &&
			userOpHashForLog
		) {
			const ambiguousTransport = error.transport ?? "bundler";
			await setPendingPaymentSubmitted(
				operationEnv,
				userOpHashForLog,
				ambiguousTransport,
				null,
			).catch((persistError) =>
				logError(
					"payment_ambiguous_submission_persist_failed",
					persistError,
					{ requestId, userOpHash: userOpHashForLog },
				),
			);
			await wakePaymentsSync(operationEnv, "payment_execution_ambiguous").catch((wakeupError) =>
				logError("payments_execution_wakeup_failed", wakeupError, { requestId, userOpHash: userOpHashForLog }),
			);
			if (claimedLinkId) {
				await markPaymentLinkClaimBroadcast(
					operationEnv,
					claimedLinkId,
					userOpHashForLog,
					userOpHashForLog,
				).catch((persistError) =>
					logError(
						"payment_ambiguous_link_claim_persist_failed",
						persistError,
						{ requestId, userOpHash: userOpHashForLog },
					),
				);
			}
			return c.json(
				{
					status: "pending",
					userOpHash: userOpHashForLog,
					transport: ambiguousTransport,
					requestId,
				},
				202,
			);
		}

		// The tx is already out but a post-broadcast persistence step failed. This
		// is NOT a payment failure. The row remains 'submitted', or 'submitting' if
		// the first write failed; the reconciler handles both states and can find
		// the operation by userOpHash. GET /pay/status/:hash resolves it.
		if (submissionAccepted) {
			return c.json(
				{ status: "pending", txHash: broadcastTxHash, userOpHash: userOpHashForLog, requestId },
				202,
			);
		}
		// Claimed but never broadcast: give the claim back so the user can retry.
		if (claimed && userOpHashForLog) {
			const submissionErrorCode =
				error instanceof UserOperationTransportError
					? error.errorCode
					: error instanceof SignerLeaseBusyError
						? "SIGNER_BUSY"
						: "SUBMISSION_FAILED";
			await releasePendingClaim(
				operationEnv,
				userOpHashForLog,
				submissionErrorCode,
			).catch(() => null);
			if (claimedLinkId) {
				await releasePaymentLinkClaim(operationEnv, claimedLinkId, userOpHashForLog).catch(() => null);
			}
		}

		if (msg.includes("AA24")) return c.json({ error: "Error de firma: esta passkey no coincide con tu wallet.", error_code: ERR.PASSKEY_MISMATCH, requestId }, 500);
		if (error instanceof SignerLeaseBusyError) {
			return c.json({ error: "El relayer está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE, requestId }, 503);
		}
		if (error instanceof UserOperationTransportError) {
			return c.json(
				{
					error: error.retryable
						? "El bundler está temporalmente no disponible. Intenta nuevamente."
						: "El bundler rechazó la operación.",
					error_code: error.errorCode,
					requestId,
				},
				error.retryable ? 503 : 400,
			);
		}
		if (msg.includes("AA21")) return c.json({ error: "Tu wallet no tiene fondos suficientes para cubrir el gas.", error_code: ERR.INSUFFICIENT_GAS, requestId }, 500);
		if (msg.includes("AA95")) return c.json({ error: "La transaccion de handleOps no tenia gas suficiente. Revisa el gas limit del relayer.", error_code: ERR.INSUFFICIENT_GAS, requestId }, 500);
		if (msg.includes("InvalidPaymasterSignature") || msg.includes("AA33") || msg.includes("AA34")) {
			return c.json({
				error: "El proveedor de patrocinio rechazó la operación. Vuelve a prepararla para obtener una autorización vigente.",
				error_code: ERR.PAYMASTER_REJECTED,
				requestId,
			}, 500);
		}
		if (msg.includes("AA31") || msg.toLowerCase().includes("deposit too low")) {
			return c.json({ error: "El proveedor de patrocinio no tiene capacidad disponible. Vuelve a preparar la operación.", error_code: ERR.PAYMASTER_DEPOSIT_LOW, requestId }, 503);
		}
		if (msg.includes("FailedOp")) {
			return c.json({ error: "La operación fue rechazada por EntryPoint.", error_code: ERR.PAYMENT_FAILED, requestId }, 500);
		}
		return c.json({ error: "Error al procesar el pago. Intenta de nuevo.", error_code: ERR.PAYMENT_FAILED, requestId }, 500);
	}
});

// GET /pay/status/:userOpHash — the payment's lifecycle state, for polling after
// a 202 (broadcast but unconfirmed) or to make the whole flow async later.
// prepared/submitting → keep waiting; submitted → broadcast (txHash present);
// confirmed/failed → terminal; unknown → expired or never prepared.
payRoutes.get("/status/:userOpHash", requireAuth, async (c) => {
	const user = c.get("user")!;
	const userOpHash = c.req.param("userOpHash") ?? "";
	if (!/^0x[0-9a-fA-F]{64}$/.test(userOpHash)) {
		return c.json({ error: "Hash inválido.", error_code: ERR.INVALID_TX_HASH }, 400);
	}
	const row = await getPendingPaymentAnyState(c.env, userOpHash);
	if (!row) return c.json({ status: "unknown" });
	if (row.uid !== user.sub) {
		return c.json({ error: "Unauthorized", error_code: ERR.WRONG_ACCOUNT }, 403);
	}
	const statusEnv = isSupportedChainKey(row.chainKey)
		? bindingsForChain(c.env, row.chainKey)
		: c.env;
	if (row.status === "submitted") {
		try {
			const receipt = await getUserOperationTransport(
				statusEnv,
				row.submissionTransport,
			).receipt({
				userOpHash: row.userOpHash as Hex,
				transactionHash: row.submittedTxHash as Hex | null,
			});
			if (receipt) {
				// "included" is a UX fast path backed by the exact transaction
				// receipt + UserOperationEvent. Durable accounting still advances
				// to "confirmed" only through the reorg-aware canonical journal.
				return c.json({
					status: receipt.success ? "included" : "failed",
					txHash: receipt.transactionHash,
					transport: row.submissionTransport,
					currency: row.currency,
					amount: row.amount,
					consistency: "sequenced",
				});
			}
		} catch (error) {
			// A point-read outage is transient; return the durable D1 lifecycle
			// below and let both the client and background reconciler retry.
			logWarn("payment_status_receipt_lookup_failed", {
				userOpHash,
				error: extractErrorMessage(error),
			});
		}
	}
	return c.json({
		status: row.status,
		txHash: row.submittedTxHash,
		transport: row.submissionTransport,
		currency: row.currency,
		amount: row.amount,
	});
});

export default payRoutes;
