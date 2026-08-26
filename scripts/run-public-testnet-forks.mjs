import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const networks = [
  {
    env: "ARBITRUM_SEPOLIA_RPC_URL",
    name: "Arbitrum Sepolia",
    chainId: "421614",
    fallback: "https://sepolia-rollup.arbitrum.io/rpc",
  },
  {
    env: "BASE_SEPOLIA_RPC_URL",
    name: "Base Sepolia",
    chainId: "84532",
    fallback: "https://sepolia.base.org",
  },
  {
    env: "AVALANCHE_FUJI_RPC_URL",
    name: "Avalanche Fuji",
    chainId: "43113",
    fallback: "https://api.avax-test.network/ext/bc/C/rpc",
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    stdio: options.stdio ?? "pipe",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `${command} exited ${result.status}`).trim());
  }
  return String(result.stdout ?? "").trim();
}

const forkEnv = { ...process.env };
for (const network of networks) {
  const rpcUrl = process.env[network.env]?.trim() || network.fallback;
  const observed = run("cast", ["chain-id", "--rpc-url", rpcUrl]);
  if (observed !== network.chainId) {
    throw new Error(`${network.name} RPC returned chain ${observed}; expected ${network.chainId}`);
  }
  forkEnv[network.env] = rpcUrl;
  console.log(`[ready] ${network.name}: chain ${observed}`);
}

run("forge", ["test"], {
  cwd: resolve(root, "contracts"),
  env: forkEnv,
  stdio: "inherit",
});

console.log("Public testnet fork proof passed with every Foundry test executed.");
