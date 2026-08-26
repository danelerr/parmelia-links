export type Hex = `0x${string}`;
export type Address = `0x${string}`;

type PaymentRoute = "local" | "cctp_fast" | "cctp_standard";
type AttemptStatus =
	| "reserved"
	| "submitted"
	| "processing"
	| "paid"
	| "overpaid"
	| "failed"
	| "expired"
	| "canceled";

type Eip1193Request = {
	method: string;
	params?: readonly unknown[] | Record<string, unknown>;
};

export type Eip1193Provider = {
	request: (args: Eip1193Request) => Promise<unknown>;
	connect?: () => Promise<unknown>;
	on?: (event: string, listener: (...args: unknown[]) => void) => void;
	removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
	disconnect?: () => Promise<void>;
};

type CheckoutLink = {
	id: string;
	intentId: string;
	amount: string;
	currency: "USDC";
	reference: string;
	wallet: Address;
	status: "pending" | "paid" | "canceled" | "expired";
	txHash: Hex | null;
	paidAt: string | null;
	paidBy: Address | null;
	createdAt: string;
};

type CheckoutIntent = {
	id: string;
	amount: string;
	amount_atomic: string;
	amount_mode: "fixed" | "payer_defined";
	currency: "USDC";
	reference: string;
	status: "awaiting_payment" | "processing" | "paid" | "overpaid" | "canceled" | "expired" | "failed";
	mode: "test" | "live";
	tx_hash: Hex | null;
	paid_at: string | null;
	paid_amount_atomic: string;
	overpaid_amount_atomic: string;
	settlement_chain_id: number;
	expires_at: string | null;
	created_at: string;
	updated_at: string;
};

export type CheckoutNetwork = {
	chain_id: number;
	name: string;
	routes: PaymentRoute[];
	usdc: Address;
	permit_mode: "eip2612" | "approve";
};

export type CheckoutResponse = {
	link: CheckoutLink;
	intent: CheckoutIntent;
	networks: CheckoutNetwork[];
};

export type CheckoutQuote = {
	id: string;
	intent_id: string;
	payer: Address;
	source_chain_id: number;
	route: PaymentRoute;
	settlement_amount_atomic: string;
	platform_fee_atomic: string;
	cctp_fee_atomic: string;
	gross_payer_amount_atomic: string;
	fee_source: "local" | "circle_live";
	platform_fee_bps: number;
	platform_fee_bearer: "none" | "payer";
	platform_fee_recipient: Address | null;
	route_fee_cap_bps: number;
	fee_observed_at: string;
	expires_at: string;
	quote_hash: Hex;
	payer_proof_message: string;
};

export type PaymentAuthorization = {
	intentId: Hex;
	attemptId: Hex;
	payer: Address;
	merchant: Address;
	settlementAmount: string;
	platformFee: string;
	validAfter: number;
	validUntil: number;
	metadataHash: Hex;
};

export type CctpPaymentAuthorization = PaymentAuthorization & {
	settlementChainId: string;
	destinationDomain: number;
	grossPayerAmount: string;
	maxCctpFee: string;
	minFinalityThreshold: number;
};

export type CheckoutAttempt = {
	id: string;
	intent_id: string;
	payer: Address;
	source_chain_id: number;
	route: PaymentRoute;
	status: AttemptStatus;
	router: Address;
	authorization: PaymentAuthorization | CctpPaymentAuthorization;
	signature: Hex;
	authorization_hash: Hex;
	valid_after: number;
	valid_until: number;
	source_tx_hash: Hex | null;
	destination_tx_hash: Hex | null;
	user_op_hash: Hex | null;
	settled_amount_atomic: string;
	intent_status?: CheckoutIntent["status"] | null;
	fee_snapshot: {
		policy_id: string;
		policy_version: number;
		rule_id: string;
		platform_fee_bps: number;
		platform_fee_atomic: string;
		network_fee_max_atomic: string;
		gross_payer_amount_atomic: string;
		bearer: "none" | "payer";
		recipient: Address | null;
		route_fee_cap_bps: number;
	};
};

export type CheckoutResume = {
	version: 2;
	linkId: string;
	idempotencyKey: string;
	attemptCapability: string;
	payer: Address;
	chainId: number;
	attemptId: string | null;
	sourceTxHash: Hex | null;
	updatedAt: string;
};
