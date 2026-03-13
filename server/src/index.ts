import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
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
import {
	accountWebAuthnAbi,
	FACTORY_ADDRESS,
	ENTRYPOINT_ADDRESS,
	PAYMASTER_ADDRESS,
	accountFactoryAbi,
	entryPointAbi,
	erc20Abi,
	USDC_ADDRESS,
	USDC_DECIMALS,
} from "../../shared";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

// Firebase public keys for ID token verification — fetched manually for workerd compatibility
let cachedJWKS: ReturnType<typeof createLocalJWKSet> | null = null;
let jwksCachedAt = 0;
const JWKS_URL = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";

async function getFirebaseJWKS() {
	const now = Date.now();
	if (cachedJWKS && now - jwksCachedAt < 3600_000) return cachedJWKS;
	const res = await fetch(JWKS_URL);
	if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
	const jwks = (await res.json()) as JSONWebKeySet;
	cachedJWKS = createLocalJWKSet(jwks);
	jwksCachedAt = now;
	return cachedJWKS;
}

interface KVNamespaceBinding {
	get(key: string, options?: string | { type?: string }): Promise<any>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

type Bindings = {
	RPC_URL: string;
	PRIVATE_KEY: string;
	FIREBASE_PROJECT_ID: string;
	PARMELIA_KV: KVNamespaceBinding;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);
app.use(logger());

// --- Helper: verify Firebase token ---
async function verifyFirebaseToken(token: string, projectId: string) {
	const jwks = await getFirebaseJWKS();
	const { payload } = await jwtVerify(token, jwks, {
		issuer: `https://securetoken.google.com/${projectId}`,
		audience: projectId,
	});
	return payload as { sub: string; email?: string; name?: string; picture?: string };
}

// --- Auth middleware ---
async function getUser(c: any) {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) return null;
	const token = authHeader.slice(7);
	try {
		return await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID);
	} catch (err: any) {
		console.error("Auth failed:", err?.message || String(err));
		return null;
	}
}

app.get("/", (c) => {
	return c.text("Parmelia Links API");
});


// ========== USER ROUTES ==========

// Get user profile
app.get("/user/profile", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized: missing, invalid, or expired Firebase token" }, 401);

	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	if (!profile) {
		return c.json({
			uid: user.sub,
			walletAddress: null,
			username: null,
		});
	}
	return c.json({
		uid: profile.uid,
		walletAddress: profile.walletAddress ?? null,
		username: profile.username ?? null,
	});
});

// Set username
app.put("/user/username", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized: missing, invalid, or expired Firebase token" }, 401);

	const { username } = await c.req.json();

	// Validate username
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return c.json({ error: "Username inválido. Solo letras minúsculas, números, guiones. 3-30 caracteres." }, 400);
	}

	// Reserved names (all client routes + system words)
	const reserved = [
		"pay", "login", "create", "settings", "admin", "api", "user",
		"cobrar", "pagar", "scan", "links", "account", "status",
		"app", "help", "support", "about", "terms", "privacy",
	];
	if (reserved.includes(username)) {
		return c.json({ error: "Username reservado" }, 400);
	}

	// Check if taken
	const existing = await c.env.PARMELIA_KV.get(`username:${username}`);
	if (existing && existing !== user.sub) {
		return c.json({ error: "Username ya está en uso" }, 409);
	}

	// If user had a previous username, clean it up
	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	if (profile?.username && profile.username !== username) {
		await c.env.PARMELIA_KV.delete(`username:${profile.username}`);
	}

	// Save username mapping
	await c.env.PARMELIA_KV.put(`username:${username}`, user.sub);

	// Update profile
	const updatedProfile = {
		...profile,
		uid: user.sub,
		username,
	};
	await c.env.PARMELIA_KV.put(`user:${user.sub}`, JSON.stringify(updatedProfile));

	return c.json({ success: true, username });
});

// ========== BALANCE ==========

app.get("/user/balance", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	const walletAddress = profile?.walletAddress as string | undefined;
	if (!walletAddress) return c.json({ error: "No wallet" }, 404);

	const publicClient = createPublicClient({
		chain: baseSepolia,
		transport: http(c.env.RPC_URL),
	});

	const [ethBalanceWei, usdcBalanceRaw] = await Promise.all([
		publicClient.getBalance({ address: walletAddress as `0x${string}` }),
		publicClient.readContract({
			address: USDC_ADDRESS as `0x${string}`,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [walletAddress as `0x${string}`],
		}) as Promise<bigint>,
	]);

	return c.json({
		eth: formatEther(ethBalanceWei),
		usdc: formatUnits(usdcBalanceRaw, USDC_DECIMALS),
		ethRaw: ethBalanceWei.toString(),
		usdcRaw: usdcBalanceRaw.toString(),
	});
});

// Get user by username (public)
app.get("/user/:username", async (c) => {
	const username = c.req.param("username");
	const uid = await c.env.PARMELIA_KV.get(`username:${username}`);
	if (!uid) return c.json({ error: "User not found" }, 404);

	const profile = await c.env.PARMELIA_KV.get(`user:${uid}`, "json") as Record<string, unknown> | null;
	if (!profile) return c.json({ error: "User not found" }, 404);

	// Return only public info
	return c.json({
		username: profile.username,
		walletAddress: profile.walletAddress,
	});
});

// ========== ACCOUNT CREATION (WebAuthn Passkey) ==========

app.post("/account/create", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized: missing, invalid, or expired Firebase token" }, 401);

	// Check if user already has a wallet
	const existingProfile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	if (existingProfile?.walletAddress) {
		return c.json({ error: "Account already exists", accountAddress: existingProfile.walletAddress }, 409);
	}

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy from passkey" }, 400);
	}

	try {
		const publicClient = createPublicClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
		});

		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);

		const walletClient = createWalletClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
			account: serverAccount,
		});

		const initCallData = encodeFunctionData({
			abi: accountWebAuthnAbi,
			functionName: "initializeWebAuthn",
			args: [qx as Hex, qy as Hex],
		});

		const predictedAddress = (await publicClient.readContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as `0x${string}`;

		const hash = await walletClient.writeContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "cloneAndInitialize",
			args: [initCallData],
		});

		await publicClient.waitForTransactionReceipt({ hash });

		// Store credentialId (NOT the private key — it never leaves the device)
		await c.env.PARMELIA_KV.put(`credential:${user.sub}`, credentialId);

		// Save wallet address to user profile
		const profile = existingProfile || {};
		const updated = {
			...profile,
			uid: user.sub,
			walletAddress: predictedAddress,
		};
		await c.env.PARMELIA_KV.put(`user:${user.sub}`, JSON.stringify(updated));

		// Auto-fund 5 USDC for new accounts (best-effort, don't block account creation)
		try {
			const alreadyFunded = await c.env.PARMELIA_KV.get(`funded:${user.sub}`);
			if (!alreadyFunded) {
				const fundAmount = parseUnits("5", USDC_DECIMALS);
				const transferData = encodeFunctionData({
					abi: erc20Abi,
					functionName: "transfer",
					args: [predictedAddress, fundAmount],
				});
				const fundTx = await walletClient.sendTransaction({
					to: USDC_ADDRESS as `0x${string}`,
					data: transferData,
				});
				await publicClient.waitForTransactionReceipt({ hash: fundTx });
				await c.env.PARMELIA_KV.put(`funded:${user.sub}`, new Date().toISOString());
			}
		} catch (fundErr) {
			console.error("Auto-fund failed (non-blocking):", fundErr);
		}

		return c.json({
			success: true,
			accountAddress: predictedAddress,
			transactionHash: hash,
		});
	} catch (error) {
		return c.json({ error: `Failed to create account: ${error}` }, 500);
	}
});

// Passkey info for UI. The stored credentialId is only a hint; payments can still
// succeed on a new device if the same passkey is synced and the browser can discover it.
app.get("/account/passkey", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	const credentialId = await c.env.PARMELIA_KV.get(`credential:${user.sub}`);
	return c.json({
		hasStoredCredential: !!credentialId,
		hasWallet: !!profile?.walletAddress,
		recoveryMode: credentialId ? "stored" : "discoverable",
	});
});

// Legacy migration route: this deploys a new smart account with new keys.
// It does not rotate the signer on the same wallet address.
app.put("/account/passkey", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	const oldWalletAddress = profile?.walletAddress as string | undefined;

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy" }, 400);
	}

	try {
		const publicClient = createPublicClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
		});

		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const walletClient = createWalletClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
			account: serverAccount,
		});

		// The initializer modifier prevents re-initialization on the same proxy,
		// so we deploy a new clone with the new keys
		const initCallData = encodeFunctionData({
			abi: accountWebAuthnAbi,
			functionName: "initializeWebAuthn",
			args: [qx as Hex, qy as Hex],
		});

		const predictedAddress = (await publicClient.readContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as `0x${string}`;

		// Deploy new clone if it doesn't exist yet
		const code = await publicClient.getCode({ address: predictedAddress });
		if (!code || code === "0x") {
			const hash = await walletClient.writeContract({
				address: FACTORY_ADDRESS,
				abi: accountFactoryAbi,
				functionName: "cloneAndInitialize",
				args: [initCallData],
			});
			await publicClient.waitForTransactionReceipt({ hash });
		}

		// Update credential and wallet address
		await c.env.PARMELIA_KV.put(`credential:${user.sub}`, credentialId);
		const updated = {
			...profile,
			uid: user.sub,
			walletAddress: predictedAddress,
		};
		await c.env.PARMELIA_KV.put(`user:${user.sub}`, JSON.stringify(updated));

		// Auto-fund new wallet if user hasn't been funded yet
		try {
			const alreadyFunded = await c.env.PARMELIA_KV.get(`funded:${user.sub}`);
			if (!alreadyFunded) {
				const fundAmount = parseUnits("5", USDC_DECIMALS);
				const transferData = encodeFunctionData({
					abi: erc20Abi,
					functionName: "transfer",
					args: [predictedAddress, fundAmount],
				});
				const fundTx = await walletClient.sendTransaction({
					to: USDC_ADDRESS as `0x${string}`,
					data: transferData,
				});
				await publicClient.waitForTransactionReceipt({ hash: fundTx });
				await c.env.PARMELIA_KV.put(`funded:${user.sub}`, new Date().toISOString());
			}
		} catch (fundErr) {
			console.error("Auto-fund during passkey update failed:", fundErr);
		}

		const walletChanged = oldWalletAddress !== predictedAddress;
		return c.json({ success: true, walletChanged, newWalletAddress: predictedAddress });
	} catch (error) {
		return c.json({ error: `Error al actualizar passkey: ${error}` }, 500);
	}
});

// ========== TESTNET FAUCET ==========

// Fund account with 5 USDC (once per user)
app.post("/account/fund", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	const walletAddress = profile?.walletAddress as string | undefined;
	if (!walletAddress) {
		return c.json({ error: "Necesitas crear una wallet primero" }, 400);
	}

	// Check if already funded
	const alreadyFunded = await c.env.PARMELIA_KV.get(`funded:${user.sub}`);
	if (alreadyFunded) {
		return c.json({ error: "Ya canjeaste tus 5 USDC de prueba", alreadyFunded: true }, 409);
	}

	try {
		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const publicClient = createPublicClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
		});
		const walletClient = createWalletClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
			account: serverAccount,
		});

		const fundAmount = parseUnits("5", USDC_DECIMALS);
		const transferData = encodeFunctionData({
			abi: erc20Abi,
			functionName: "transfer",
			args: [walletAddress as `0x${string}`, fundAmount],
		});

		const txHash = await walletClient.sendTransaction({
			to: USDC_ADDRESS as `0x${string}`,
			data: transferData,
		});
		await publicClient.waitForTransactionReceipt({ hash: txHash });

		await c.env.PARMELIA_KV.put(`funded:${user.sub}`, new Date().toISOString());

		return c.json({ success: true, txHash, amount: "5", currency: "USDC" });
	} catch (error) {
		return c.json({ error: `Error al fondear cuenta: ${error}` }, 500);
	}
});

// Check if user has already claimed testnet USDC
app.get("/account/fund", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	const funded = await c.env.PARMELIA_KV.get(`funded:${user.sub}`);
	return c.json({ funded: !!funded, fundedAt: funded || null });
});

// ========== TRANSACTIONS ==========

app.get("/user/transactions", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);

	// Get sent transactions
	const sentTxs = (await c.env.PARMELIA_KV.get(`sent:${user.sub}`, "json") as any[] | null) || [];

	// Get received transactions (from links that were paid)
	const linkIds = (await c.env.PARMELIA_KV.get(`userlinks:${user.sub}`, "json") as string[] | null) || [];
	const links = await Promise.all(
		linkIds.slice(0, 50).map(async (id) => c.env.PARMELIA_KV.get(`link:${id}`, "json")),
	);
	const receivedTxs = (links.filter(Boolean) as any[])
		.filter((l) => l.status === "paid")
		.map((l) => ({
			txHash: l.txHash || "",
			amount: l.amount,
			currency: l.currency,
			reference: l.reference || "",
			paidBy: l.paidBy || "",
			createdAt: l.paidAt || l.createdAt,
		}));

	return c.json({ sent: sentTxs, received: receivedTxs });
});

// ========== PAYMENT LINKS ==========

// Create payment link
app.post("/links", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized: missing, invalid, or expired Firebase token" }, 401);

	const { amount, currency, reference } = await c.req.json();

	if (!amount || Number(amount) <= 0) {
		return c.json({ error: "Amount is required and must be positive" }, 400);
	}

	const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
	const walletAddress = profile?.walletAddress as string | undefined;

	if (!walletAddress) {
		return c.json({ error: "Necesitas crear una wallet antes de crear un link de cobro" }, 400);
	}

	const id = crypto.randomUUID();
	const link = {
		id,
		amount: String(amount),
		currency: currency || "USDC",
		reference: reference || "",
		wallet: walletAddress || "",
		ownerUid: user.sub,
		status: "pending" as const,
		createdAt: new Date().toISOString(),
	};

	await c.env.PARMELIA_KV.put(`link:${id}`, JSON.stringify(link));

	// Add to user's links list
	const userLinks = (await c.env.PARMELIA_KV.get(`userlinks:${user.sub}`, "json") as string[] | null) || [];
	userLinks.unshift(id);
	await c.env.PARMELIA_KV.put(`userlinks:${user.sub}`, JSON.stringify(userLinks.slice(0, 100)));

	return c.json(link);
});

// List user's payment links
app.get("/links", async (c) => {
	const user = await getUser(c);
	if (!user) return c.json({ error: "Unauthorized: missing, invalid, or expired Firebase token" }, 401);

	const linkIds = (await c.env.PARMELIA_KV.get(`userlinks:${user.sub}`, "json") as string[] | null) || [];

	const links = await Promise.all(
		linkIds.slice(0, 20).map(async (id) => {
			const data = await c.env.PARMELIA_KV.get(`link:${id}`, "json");
			return data;
		}),
	);

	return c.json({ links: links.filter(Boolean) });
});

// Get single payment link (public)
app.get("/links/:id", async (c) => {
	const id = c.req.param("id");
	const link = await c.env.PARMELIA_KV.get(`link:${id}`, "json");
	if (!link) return c.json({ error: "Link not found" }, 404);
	return c.json(link);
});

// ========== PAYMENT EXECUTION ==========

// Helper: Build ERC7821 execute calldata for a single call (batch mode with 1 item)
// OZ ERC7821 only supports CALLTYPE_BATCH (0x01). executionData = abi.encode(Execution[])
function buildExecuteCalldata(target: `0x${string}`, value: bigint, data: Hex): Hex {
	// mode: callType=0x01 (batch) in first byte, execType=0x00 (default), rest zeros
	const mode = pad("0x01", { size: 32, dir: "right" }) as Hex;
	// executionData: abi.encode(Execution[]) where Execution = (address target, uint256 value, bytes callData)
	const executionData = encodeAbiParameters(
		parseAbiParameters("(address target, uint256 value, bytes callData)[]"),
		[[{ target, value, callData: data }]],
	);
	return encodeFunctionData({
		abi: [
			{
				name: "execute",
				type: "function",
				inputs: [
					{ name: "mode", type: "bytes32" },
					{ name: "executionData", type: "bytes" },
				],
				outputs: [],
			},
		],
		functionName: "execute",
		args: [mode, executionData],
	});
}

// Helper: Serialize bigints for JSON
function serializeBigInts(obj: any): any {
	if (typeof obj === "bigint") return "0x" + obj.toString(16);
	if (Array.isArray(obj)) return obj.map(serializeBigInts);
	if (obj !== null && typeof obj === "object") {
		return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, serializeBigInts(v)]));
	}
	return obj;
}

// Step 1: Build unsigned UserOp and return the hash for client-side signing
app.post("/pay/prepare", async (c) => {
	try {
		const user = await getUser(c);
		if (!user) return c.json({ error: "Unauthorized — login required to pay" }, 401);

		const { linkId, wallet, amount, currency } = await c.req.json();
		if (!wallet || !amount) {
			return c.json({ error: "Missing wallet or amount" }, 400);
		}

		const profile = await c.env.PARMELIA_KV.get(`user:${user.sub}`, "json") as Record<string, unknown> | null;
		const senderAddress = profile?.walletAddress as string | undefined;
		if (!senderAddress) {
			return c.json({ error: "You need a wallet to pay. Create one first." }, 400);
		}

		const credentialId = await c.env.PARMELIA_KV.get(`credential:${user.sub}`);

		const publicClient = createPublicClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
		});

		// Build callData
		const recipientAddress = wallet as `0x${string}`;
		let executeCalldata: Hex;

		if (currency === "USDC") {
			const usdcAmount = parseUnits(String(amount), USDC_DECIMALS);
			const usdcBalance = await publicClient.readContract({
				address: USDC_ADDRESS as `0x${string}`,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [senderAddress as `0x${string}`],
			}) as bigint;
			if (usdcBalance < usdcAmount) {
				return c.json({ error: `Saldo USDC insuficiente (tienes ${formatUnits(usdcBalance, USDC_DECIMALS)} USDC)` }, 400);
			}
			const transferData = encodeFunctionData({
				abi: erc20Abi,
				functionName: "transfer",
				args: [recipientAddress, usdcAmount],
			});
			executeCalldata = buildExecuteCalldata(USDC_ADDRESS as `0x${string}`, 0n, transferData);
		} else {
			const ethAmount = parseEther(String(amount));
			const ethBalance = await publicClient.getBalance({ address: senderAddress as `0x${string}` });
			if (ethBalance < ethAmount) {
				return c.json({ error: `Saldo ETH insuficiente (tienes ${formatEther(ethBalance)} ETH)` }, 400);
			}
			executeCalldata = buildExecuteCalldata(recipientAddress, ethAmount, "0x");
		}

		// Get nonce
		const nonce = await publicClient.readContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "getNonce",
			args: [senderAddress as `0x${string}`, 0n],
		}) as bigint;

		// Gas prices
		const gasPrice = await publicClient.getGasPrice();
		const maxFeePerGas = gasPrice * 2n;
		const maxPriorityFeePerGas = gasPrice / 10n > 1000000n ? gasPrice / 10n : 1000000n;

		const verificationGasLimit = 500000n;
		const callGasLimit = 300000n;
		const preVerificationGas = 100000n;
		const paymasterVerificationGasLimit = 100000n;
		const paymasterPostOpGasLimit = 50000n;

		const accountGasLimits = concat([
			pad(toHex(verificationGasLimit), { size: 16 }),
			pad(toHex(callGasLimit), { size: 16 }),
		]) as Hex;

		const gasFees = concat([
			pad(toHex(maxPriorityFeePerGas), { size: 16 }),
			pad(toHex(maxFeePerGas), { size: 16 }),
		]) as Hex;

		const paymasterAndData = encodePacked(
			["address", "uint128", "uint128"],
			[PAYMASTER_ADDRESS as `0x${string}`, paymasterVerificationGasLimit, paymasterPostOpGasLimit],
		);

		const userOp = {
			sender: senderAddress as `0x${string}`,
			nonce,
			initCode: "0x" as Hex,
			callData: executeCalldata,
			accountGasLimits,
			preVerificationGas,
			gasFees,
			paymasterAndData,
			signature: "0x" as Hex,
		};

		// Get the hash the client needs to sign
		const userOpHash = await publicClient.readContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "getUserOpHash",
			args: [userOp],
		}) as Hex;

		// Store the pending UserOp in KV (short TTL)
		const pendingKey = `pending:${userOpHash}`;
		await c.env.PARMELIA_KV.put(pendingKey, JSON.stringify({
			userOp: serializeBigInts(userOp),
			linkId,
			uid: user.sub,
			amount: String(amount),
			currency,
			wallet,
			senderAddress,
		}));

		return c.json({ userOpHash, credentialId: credentialId || null });
	} catch (error) {
		console.error("Prepare error:", error);
		return c.json({ error: "Error al preparar el pago. Intenta de nuevo." }, 500);
	}
});

// Step 2: Receive the WebAuthn assertion from the client, encode signature, and submit
app.post("/pay/submit", async (c) => {
	try {
		const user = await getUser(c);
		if (!user) return c.json({ error: "Unauthorized" }, 401);

		const { userOpHash, authenticatorData, clientDataJSON, r, s, credentialId } = await c.req.json();
		if (!userOpHash || !authenticatorData || !clientDataJSON || !r || !s) {
			return c.json({ error: "Missing signature data" }, 400);
		}

		// Retrieve the pending UserOp
		const pendingKey = `pending:${userOpHash}`;
		const pending = await c.env.PARMELIA_KV.get(pendingKey, "json") as {
			userOp: Record<string, any>;
			linkId?: string;
			uid: string;
			amount?: string;
			currency?: string;
			wallet?: string;
			senderAddress?: string;
		} | null;
		if (!pending) {
			return c.json({ error: "No pending payment found for this hash" }, 404);
		}
		if (pending.uid !== user.sub) {
			return c.json({ error: "Unauthorized" }, 403);
		}

		// Delete the pending entry
		await c.env.PARMELIA_KV.delete(pendingKey);

		// Find challengeIndex and typeIndex in clientDataJSON
		const typeIndex = (clientDataJSON as string).indexOf('"type"');
		const challengeIndex = (clientDataJSON as string).indexOf('"challenge"');

		// Normalize s to low-s (OZ P256.verify rejects s > N/2 for malleability protection)
		const P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
		const P256_N_DIV_2 = P256_N / 2n;
		let normalizedS = BigInt(s as string);
		if (normalizedS > P256_N_DIV_2) {
			normalizedS = P256_N - normalizedS;
		}
		const normalizedSHex = ("0x" + normalizedS.toString(16).padStart(64, "0")) as Hex;

		// ABI encode the WebAuthnAuth struct
		const signature = encodeAbiParameters(
			parseAbiParameters("bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex, bytes authenticatorData, string clientDataJSON"),
			[
				r as Hex,
				normalizedSHex,
				BigInt(challengeIndex),
				BigInt(typeIndex),
				authenticatorData as Hex,
				clientDataJSON as string,
			],
		);

		// Reconstruct the UserOp with proper types
		const raw = pending.userOp;
		const userOp = {
			sender: raw.sender as `0x${string}`,
			nonce: BigInt(raw.nonce),
			initCode: raw.initCode as Hex,
			callData: raw.callData as Hex,
			accountGasLimits: raw.accountGasLimits as Hex,
			preVerificationGas: BigInt(raw.preVerificationGas),
			gasFees: raw.gasFees as Hex,
			paymasterAndData: raw.paymasterAndData as Hex,
			signature,
		};

		const publicClient = createPublicClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
		});

		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const walletClient = createWalletClient({
			chain: baseSepolia,
			transport: http(c.env.RPC_URL),
			account: serverAccount,
		});

		// Submit to EntryPoint
		const txHash = await walletClient.writeContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "handleOps",
			args: [[userOp], serverAccount.address],
		});

		const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

		if (receipt.status === "reverted") {
			return c.json({ error: "Transaction reverted" }, 500);
		}

		// Check UserOperationEvent success
		const userOpEventTopic = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
		const userOpEvent = receipt.logs.find((log: any) => log.topics[0] === userOpEventTopic);
		if (userOpEvent) {
			const data = userOpEvent.data as string;
			const successWord = data.slice(66, 130);
			const success = BigInt(`0x${successWord}`) === 1n;
			if (!success) {
				console.error("UserOp failed on-chain. Data:", userOpEvent.data);
				return c.json({ error: "UserOperation executed but failed on-chain", txHash }, 500);
			}
		}

		// Refresh the credentialId hint after a successful signature from this device.
		try {
			if (credentialId) {
				await c.env.PARMELIA_KV.put(`credential:${user.sub}`, credentialId);
			}
		} catch (credentialErr) {
			console.error("Failed to refresh credentialId:", credentialErr);
		}

		// Save sent transaction record
		try {
			const sentKey = `sent:${user.sub}`;
			const sentTxs = (await c.env.PARMELIA_KV.get(sentKey, "json") as any[] | null) || [];
			sentTxs.unshift({
				txHash,
				amount: pending.amount || "0",
				currency: pending.currency || "USDC",
				to: pending.wallet || "",
				createdAt: new Date().toISOString(),
			});
			await c.env.PARMELIA_KV.put(sentKey, JSON.stringify(sentTxs.slice(0, 100)));
		} catch (sentErr) {
			console.error("Failed to save sent tx record:", sentErr);
		}

		// Update link status
		const linkId = pending.linkId;
		if (linkId && linkId !== "direct" && linkId !== "username" && linkId !== "manual") {
			const link = await c.env.PARMELIA_KV.get(`link:${linkId}`, "json") as Record<string, unknown> | null;
			if (link) {
				await c.env.PARMELIA_KV.put(`link:${linkId}`, JSON.stringify({
					...link,
					status: "paid",
					txHash,
					paidAt: new Date().toISOString(),
					paidBy: pending.senderAddress || "",
				}));
			}
		}

		return c.json({ status: "success", txHash });
	} catch (error) {
		console.error("Submit error:", error);
		const msg = String(error);
		if (msg.includes("AA24")) {
			return c.json({ error: "Error de firma: esta passkey no coincide con tu wallet. Intenta con la passkey sincronizada del dispositivo original o usa autenticacion desde otro dispositivo." }, 500);
		}
		if (msg.includes("AA21")) {
			return c.json({ error: "Tu wallet no tiene fondos suficientes para cubrir el gas." }, 500);
		}
		if (msg.includes("AA25")) {
			return c.json({ error: "Error de firma: datos de autenticación inválidos." }, 500);
		}
		if (msg.includes("insufficient") || msg.includes("Insufficient")) {
			return c.json({ error: "Fondos insuficientes para esta transacción." }, 500);
		}
		return c.json({ error: "Error al procesar el pago. Intenta de nuevo." }, 500);
	}
});

export default app;




