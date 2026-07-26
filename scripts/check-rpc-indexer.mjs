#!/usr/bin/env node

const NETWORKS = {
  "arbitrum-sepolia": {
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    token: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
  },
  "arbitrum-one": {
    rpc: "https://arb1.arbitrum.io/rpc",
    token: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
};

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PROBE_RECIPIENT_TOPIC =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const REQUEST_TIMEOUT_MS = 30_000;

function parsePositiveInteger(raw, name, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function endpointAlias(raw, slot) {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname.endsWith(".alchemy.com") || hostname.endsWith(".alchemyapi.io")) {
      return "alchemy";
    }
    if (hostname === "sepolia-rollup.arbitrum.io") {
      return "arbitrum-public-sepolia";
    }
    if (hostname === "arb1.arbitrum.io") return "arbitrum-public-one";
  } catch {
    // The request below reports malformed URLs without echoing their contents.
  }
	return `indexer-endpoint-${slot + 1}`;
}

function isAlchemyEndpoint(raw) {
	try {
		const hostname = new URL(raw).hostname.toLowerCase();
		return (
			hostname === "alchemy.com" ||
			hostname.endsWith(".alchemy.com") ||
			hostname === "alchemyapi.io" ||
			hostname.endsWith(".alchemyapi.io")
		);
	} catch {
		return false;
	}
}

async function rpc(endpoint, method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    const code =
      typeof payload.error.code === "number" ? payload.error.code : "unknown";
    throw new Error(`JSON-RPC ${code}`);
  }
  return payload.result;
}

async function probe(endpoint, alias, network, span) {
  const headHex = await rpc(endpoint, "eth_blockNumber", []);
  const head = BigInt(headHex);
  const from = head >= BigInt(span - 1) ? head - BigInt(span - 1) : 0n;
  const startedAt = performance.now();
  const logs = await rpc(endpoint, "eth_getLogs", [
    {
      address: network.token,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${head.toString(16)}`,
      topics: [TRANSFER_TOPIC, null, PROBE_RECIPIENT_TOPIC],
    },
  ]);
  return {
    endpoint: alias,
    span,
    latencyMs: Math.round(performance.now() - startedAt),
    resultCount: Array.isArray(logs) ? logs.length : 0,
  };
}

async function main() {
  const chainKey = process.env.CHAIN_KEY ?? "arbitrum-sepolia";
  const network = NETWORKS[chainKey];
  if (!network) {
    throw new Error(
      `CHAIN_KEY must be one of: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  const span = parsePositiveInteger(
    process.env.RPC_INDEXER_MAX_BLOCK_RANGE ?? "2000",
    "RPC_INDEXER_MAX_BLOCK_RANGE",
    2_000,
  );
  const endpoints = (process.env.RPC_INDEXER_URLS ?? network.rpc)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (endpoints.length === 0) throw new Error("RPC_INDEXER_URLS is empty");
  if (span > 10 && endpoints.some(isAlchemyEndpoint)) {
    throw new Error(
      "Alchemy Free cannot be probed above 10 blocks; use the independent Arbitrum indexer RPC",
    );
  }

  const results = [];
  for (const [slot, endpoint] of endpoints.entries()) {
    const alias = endpointAlias(endpoint, slot);
    try {
      results.push(await probe(endpoint, alias, network, span));
    } catch (error) {
      throw new Error(
        `${alias} rejected the configured ${span}-block indexer probe: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        chain: chainKey,
        configuredSpan: span,
        endpoints: results,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    }),
  );
  process.exitCode = 1;
});
