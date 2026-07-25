// Runtime bindings come from Wrangler's generated CloudflareBindings. Secrets
// and feature flags are optional in testnet/local environments and validated
// explicitly by runtimeConfig before mainnet traffic is accepted.
type OptionalBindingKey =
	| "ALLOWED_ORIGINS"
	| "FAUCET_PRIVATE_KEY"
	| "RECOVERY_GUARDIAN_PRIVATE_KEY"
	| "PAYMASTER_SIGNER_PRIVATE_KEY"
	| "PAYMENT_ROUTER_SIGNER_PRIVATE_KEY"
	| "TURNSTILE_SECRET_KEY"
	| "FCM_SERVICE_ACCOUNT"
	| "APP_URL"
	| "PARMELIA_FEES_ENABLED"
	| "PARMELIA_SWAP_FEE_BPS"
	| "PARMELIA_MAX_FEE_BPS"
	| "PARMELIA_TREASURY_ADDRESS"
	| "PARMELIA_CROSSCHAIN_FEE_BPS"
	| "PARMELIA_PAYMENT_FEE_BPS"
	| "CCTP_RPC_URLS"
	| "CROSSCHAIN_PAUSED"
	| "CROSSCHAIN_DISABLED_CHAINS"
	| "CROSSCHAIN_MIN_RELAYER_GAS_WEI"
	| "EARN_PAUSED"
	| "FAUCET_ENABLED"
	| "FAUCET_DAILY_BUDGET_USDC"
	| "WEBHOOK_SECRET_ENCRYPTION_KEY"
	| "WEBHOOK_SECRET_ENCRYPTION_KEY_ID"
	| "WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS";

type StringBindingKey = {
	[Key in keyof CloudflareBindings]-?: CloudflareBindings[Key] extends string ? Key : never;
}[keyof CloudflareBindings];

// Wrangler preserves literal values from `vars` in generated types. Runtime
// deployments legitimately override those values per environment, so expose
// every string binding as `string` while retaining D1 and other binding types.
export type Bindings = Omit<CloudflareBindings, StringBindingKey> &
	Record<Exclude<StringBindingKey, OptionalBindingKey>, string> &
	Partial<Record<OptionalBindingKey, string>>;
