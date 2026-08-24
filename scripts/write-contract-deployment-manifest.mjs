import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}`;

function fail(message) {
	throw new Error(`[deployment-manifest] ${message}`);
}

function parseArgs(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
			fail(`expected --key value arguments; invalid token '${key ?? ""}'`);
		}
		values.set(key.slice(2), value);
	}
	return values;
}

function required(args, key) {
	const value = args.get(key);
	if (!value) fail(`missing --${key}`);
	return value;
}

function normalizeAddress(value, label) {
	if (!/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`${label} is not an address`);
	return value.toLowerCase();
}

function normalizeHash(value, label) {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`${label} is not a bytes32 hash`);
	return value.toLowerCase();
}

async function rpc(rpcUrl, method, params) {
	const response = await fetch(rpcUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	if (!response.ok) fail(`${method} returned HTTP ${response.status}`);
	const payload = await response.json();
	if (payload.error) fail(`${method} failed: ${payload.error.message ?? "unknown RPC error"}`);
	return payload.result;
}

function selector(signature) {
	return execFileSync("cast", ["sig", signature], { encoding: "utf8" }).trim();
}

function keccak(hexData) {
	return normalizeHash(
		execFileSync("cast", ["keccak", hexData], { encoding: "utf8" }).trim(),
		"runtime bytecode hash",
	);
}

function git(args) {
	return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

async function readAddress(rpcUrl, contractAddress, signature) {
	const result = await rpc(rpcUrl, "eth_call", [
		{ to: contractAddress, data: selector(signature) },
		"latest",
	]);
	if (!/^0x[0-9a-fA-F]{64}$/.test(result)) fail(`${signature} returned malformed data`);
	return normalizeAddress(`0x${result.slice(-40)}`, `${signature} result`);
}

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const broadcastPath = resolve(root, required(args, "broadcast"));
const outputPath = resolve(root, required(args, "output"));
const contractName = required(args, "contract");
const rpcUrl = required(args, "rpc-url");
const expectedChainId = Number(required(args, "chain-id"));
if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) {
	fail("--chain-id must be a positive safe integer");
}
const roleProfile = args.get("role-profile") ?? "checkout";
if (roleProfile !== "checkout" && roleProfile !== "crosschain") {
	fail("--role-profile must be checkout or crosschain");
}

const expectedRoles = {
	owner: normalizeAddress(required(args, "owner"), "owner"),
	treasury: normalizeAddress(required(args, "treasury"), "treasury"),
	authorizationSigner:
		roleProfile === "checkout"
			? normalizeAddress(required(args, "authorization-signer"), "authorization signer")
			: null,
	pauseGuardian:
		roleProfile === "checkout"
			? normalizeAddress(required(args, "pause-guardian"), "pause guardian")
			: null,
};

const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8"));
const matchingTransactions = broadcast.transactions.filter(
	(transaction) => transaction.contractName === contractName,
);
if (matchingTransactions.length !== 1) {
	fail(`expected exactly one ${contractName} transaction, found ${matchingTransactions.length}`);
}
const transaction = matchingTransactions[0];
const transactionHash = normalizeHash(transaction.hash ?? "", "transaction hash");
const contractAddress = normalizeAddress(transaction.contractAddress ?? "", "contract address");
const receipt = broadcast.receipts.find(
	(item) => item.transactionHash?.toLowerCase() === transactionHash,
);
if (!receipt || receipt.status !== "0x1") fail("broadcast receipt is absent or unsuccessful");

const rpcChainId = Number.parseInt(await rpc(rpcUrl, "eth_chainId", []), 16);
if (rpcChainId !== expectedChainId || Number(broadcast.chain) !== expectedChainId) {
	fail(
		`chain mismatch: expected ${expectedChainId}, RPC ${rpcChainId}, broadcast ${broadcast.chain}`,
	);
}

const liveTransaction = await rpc(rpcUrl, "eth_getTransactionByHash", [transactionHash]);
const liveReceipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [transactionHash]);
if (!liveTransaction || !liveReceipt) fail("transaction or receipt is absent from the configured RPC");
if (liveReceipt.status !== "0x1") fail("on-chain transaction was not successful");

const expectedTransaction = transaction.transaction ?? {};
const expectedFrom = normalizeAddress(expectedTransaction.from ?? "", "broadcast sender");
const expectedTo = normalizeAddress(expectedTransaction.to ?? "", "broadcast transaction target");
if (normalizeAddress(liveTransaction.from ?? "", "on-chain sender") !== expectedFrom) {
	fail("on-chain sender does not match the broadcast artifact");
}
if (normalizeAddress(liveTransaction.to ?? "", "on-chain transaction target") !== expectedTo) {
	fail("on-chain transaction target does not match the broadcast artifact");
}
if ((liveTransaction.input ?? "").toLowerCase() !== (expectedTransaction.input ?? "").toLowerCase()) {
	fail("on-chain calldata does not match the broadcast artifact");
}
if (BigInt(liveTransaction.value ?? "0x0") !== BigInt(expectedTransaction.value ?? "0x0")) {
	fail("on-chain transaction value does not match the broadcast artifact");
}
const savedBlockHash = (receipt.blockHash ?? "").toLowerCase();
if (savedBlockHash !== ZERO_HASH && (liveReceipt.blockHash ?? "").toLowerCase() !== savedBlockHash) {
	fail("on-chain block hash does not match the broadcast receipt");
}
if (BigInt(liveReceipt.blockNumber ?? "0x0") !== BigInt(receipt.blockNumber ?? "0x0")) {
	fail("on-chain block number does not match the broadcast receipt");
}

const runtimeBytecode = await rpc(rpcUrl, "eth_getCode", [contractAddress, "latest"]);
if (runtimeBytecode === "0x") fail("deployed address has no runtime bytecode at latest");
const latestRuntimeHash = keccak(runtimeBytecode);

let deploymentBlockChecked = false;
try {
	const runtimeAtDeployment = await rpc(rpcUrl, "eth_getCode", [
		contractAddress,
		liveReceipt.blockNumber,
	]);
	if (runtimeAtDeployment === "0x") fail("deployed address had no runtime bytecode at its deployment block");
	const deploymentRuntimeHash = keccak(runtimeAtDeployment);
	if (deploymentRuntimeHash !== latestRuntimeHash) {
		fail(`runtime bytecode changed after deployment: ${deploymentRuntimeHash} -> ${latestRuntimeHash}`);
	}
	deploymentBlockChecked = true;
} catch (error) {
	if (String(error).includes("runtime bytecode changed") || String(error).includes("had no runtime bytecode")) {
		throw error;
	}
	process.stderr.write(
		`[deployment-manifest] warning: RPC cannot serve historical state at block ${Number.parseInt(liveReceipt.blockNumber, 16)}; latest bytecode remains verified\n`,
	);
}

const onchainRoles = {
	owner: await readAddress(rpcUrl, contractAddress, "owner()"),
	treasury: await readAddress(rpcUrl, contractAddress, "treasury()"),
	authorizationSigner:
		roleProfile === "checkout"
			? await readAddress(rpcUrl, contractAddress, "authorizationSigner()")
			: null,
	pauseGuardian:
		roleProfile === "checkout"
			? await readAddress(rpcUrl, contractAddress, "pauseGuardian()")
			: null,
	pendingOwner: await readAddress(rpcUrl, contractAddress, "pendingOwner()"),
};

for (const [role, expected] of Object.entries(expectedRoles)) {
	if (onchainRoles[role] !== expected) {
		fail(`${role} mismatch: expected ${expected}, on-chain ${onchainRoles[role]}`);
	}
}
if (onchainRoles.pendingOwner !== ZERO_ADDRESS) {
	fail(`ownership handoff is still pending for ${onchainRoles.pendingOwner}`);
}

const verificationUrl = args.get("verification-url") ?? null;
const currentCommit = git(["rev-parse", "HEAD"]);
const broadcastCommit = broadcast.commit
	? git(["rev-parse", `${broadcast.commit}^{commit}`])
	: currentCommit;
const manifest = {
	schemaVersion: 1,
	chainId: expectedChainId,
	contractName,
	address: contractAddress,
	transactionHash,
	blockNumber: Number.parseInt(liveReceipt.blockNumber, 16),
	deployer: expectedFrom,
	constructorArguments: transaction.arguments ?? [],
	runtimeBytecodeHash: latestRuntimeHash,
	runtimeBytecodeChecks: {
		latest: true,
		deploymentBlock: deploymentBlockChecked,
	},
	roles: {
		...onchainRoles,
		ownershipAccepted: true,
	},
	compiler: {
		solc: "0.8.34",
		viaIr: true,
		evmVersion: "cancun",
		optimizer: true,
		optimizerRuns: 1_000_000,
	},
	source: {
		commit: broadcastCommit,
		matchesCurrentHead: broadcastCommit === currentCommit,
		worktreeDirty: git(["status", "--porcelain", "--untracked-files=all"]).length > 0,
		broadcastFile: relative(root, broadcastPath).replaceAll("\\", "/"),
		verification: verificationUrl
			? { status: "verified", url: verificationUrl }
			: { status: "pending", url: null },
	},
	createdAt: new Date().toISOString(),
};

mkdirSync(dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
	encoding: "utf8",
	mode: 0o600,
});
renameSync(temporaryPath, outputPath);
process.stdout.write(
	`Wrote ${relative(root, outputPath)} for ${contractName} at ${contractAddress}\n`,
);
