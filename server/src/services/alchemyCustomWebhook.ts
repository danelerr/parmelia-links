import { toEventSelector } from "viem";
import type { Bindings } from "../middlewares/auth";
import {
	finishSourceDelivery,
	getSourceDelivery,
	recordSourceDelivery,
} from "./chainJournal";
import { scheduleEventJob } from "./eventScheduler";
import { verifyAlchemySignature } from "./alchemyWebhook";
import { logInfo } from "./logger";
import {
	scheduleAllShardPartitions,
	scheduleWalletWatcherPartitions,
} from "./indexerPartitions";

type CustomWebhookEnvelope = {
	webhookId?: string;
	id?: string;
	type?: string;
	event?: {
		sequenceNumber?: string;
		data?: unknown;
	};
};

const INVOICE_PAID_TOPIC = toEventSelector(
	"InvoicePaid(bytes32,address,address,address,uint256,uint256,bytes)",
).toLowerCase();
const RECOVERY_PROPOSED_TOPIC = toEventSelector(
	"RecoveryProposed(address,uint256)",
).toLowerCase();
const MAX_SIGNAL_VALUES = 5_000;
const MAX_SIGNAL_ADDRESSES = 1_000;

type CustomSignalScope = {
	addresses: string[];
	router: boolean;
	recovery: boolean;
	recognizedTopic: boolean;
	truncated: boolean;
};

function inspectCustomSignalData(value: unknown): CustomSignalScope {
	const pending: unknown[] = [value];
	const addresses = new Set<string>();
	let router = false;
	let recovery = false;
	let visited = 0;
	while (
		pending.length > 0 &&
		visited < MAX_SIGNAL_VALUES &&
		addresses.size < MAX_SIGNAL_ADDRESSES
	) {
		const current = pending.pop();
		visited++;
		if (typeof current === "string") {
			const normalized = current.toLowerCase();
			if (normalized === INVOICE_PAID_TOPIC) router = true;
			if (normalized === RECOVERY_PROPOSED_TOPIC) recovery = true;
			if (/^0x[0-9a-f]{40}$/u.test(normalized)) {
				addresses.add(normalized);
			} else if (/^0x0{24}[0-9a-f]{40}$/u.test(normalized)) {
				// Indexed EVM addresses are left-padded to one 32-byte topic.
				addresses.add(`0x${normalized.slice(-40)}`);
			}
			continue;
		}
		if (Array.isArray(current)) {
			pending.push(...current);
			continue;
		}
		if (current && typeof current === "object") {
			pending.push(...Object.values(current as Record<string, unknown>));
		}
	}
	return {
		addresses: [...addresses],
		router,
		recovery,
		recognizedTopic: router || recovery,
		truncated:
			pending.length > 0 || addresses.size >= MAX_SIGNAL_ADDRESSES,
	};
}

function parseCustomEnvelope(rawBody: string): CustomWebhookEnvelope | null {
	try {
		const parsed = JSON.parse(rawBody) as CustomWebhookEnvelope;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.webhookId !== "string" ||
			typeof parsed.id !== "string" ||
			parsed.type !== "GRAPHQL" ||
			!parsed.event ||
			typeof parsed.event !== "object" ||
			typeof parsed.event.sequenceNumber !== "string" ||
			parsed.event.data === undefined
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export type AlchemyCustomWebhookResult =
	| { status: "disabled" }
	| { status: "invalid_signature" }
	| { status: "invalid_payload" }
	| { status: "rejected_scope" }
	| { status: "duplicate"; deliveryId: string }
	| { status: "processed"; deliveryId: string };

/**
 * Custom Webhook is only a wakeup signal. Financial/security truth is still
 * read through the independent indexer RPC by the existing bounded watchers.
 */
export async function processAlchemyCustomWebhook(
	env: Bindings,
	rawBody: string,
	signature: string | undefined,
): Promise<AlchemyCustomWebhookResult> {
	if (env.ALCHEMY_CUSTOM_WEBHOOK_ENABLED !== "true") {
		return { status: "disabled" };
	}
	if (
		!(await verifyAlchemySignature(
			rawBody,
			signature,
			env.ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY,
		))
	) {
		return { status: "invalid_signature" };
	}
	const envelope = parseCustomEnvelope(rawBody);
	if (!envelope) return { status: "invalid_payload" };
	if (envelope.webhookId !== env.ALCHEMY_CUSTOM_WEBHOOK_ID) {
		await recordSourceDelivery(env, {
			provider: "alchemy_custom",
			deliveryId: envelope.id!,
			webhookId: envelope.webhookId,
			status: "rejected",
			errorCode: "SCOPE_MISMATCH",
		});
		return { status: "rejected_scope" };
	}

	const firstDelivery = await recordSourceDelivery(env, {
		provider: "alchemy_custom",
		deliveryId: envelope.id!,
		webhookId: envelope.webhookId,
		status: "received",
	});
	if (!firstDelivery) {
		const prior = await getSourceDelivery(
			env,
			"alchemy_custom",
			envelope.id!,
		);
		if (prior?.status === "processed" || prior?.status === "rejected") {
			return { status: "duplicate", deliveryId: envelope.id! };
		}
	}

	const signal = inspectCustomSignalData(envelope.event!.data);
	// Unknown/truncated provider schemas fail safely by waking both canonical
	// readers. A recognized topic wakes only its owning stream.
	const wakeRouter =
		signal.router || !signal.recognizedTopic || signal.truncated;
	const wakeRecovery =
		signal.recovery || !signal.recognizedTopic || signal.truncated;
	const schedules: Promise<unknown>[] = [];
	if (wakeRouter) {
		schedules.push(
			scheduleEventJob(env, "router_watcher", {
				delayMs: 10_000,
				reason: "alchemy_custom_chain_event",
			}),
		);
	}
	if (wakeRecovery) {
		schedules.push((async () => {
			const exactPartitions = await scheduleWalletWatcherPartitions(
				env,
				signal.addresses,
				"recovery_watcher",
				"alchemy_custom_chain_event",
			);
			if (exactPartitions === 0) {
				await scheduleAllShardPartitions(
					env,
					"recovery_watcher",
					"alchemy_custom_chain_event",
				);
			}
		})());
	}
	await Promise.all(schedules);
	await finishSourceDelivery(
		env,
		"alchemy_custom",
		envelope.id!,
		"processed",
		1,
	);
	logInfo("alchemy_custom_webhook_processed", {
		deliveryId: envelope.id!,
		sequenceNumber: envelope.event!.sequenceNumber,
		routerSignal: wakeRouter,
		recoverySignal: wakeRecovery,
		addressCandidates: signal.addresses.length,
		schemaFallback: !signal.recognizedTopic || signal.truncated,
	});
	return { status: "processed", deliveryId: envelope.id! };
}

export const __test = {
	parseCustomEnvelope,
	inspectCustomSignalData,
	INVOICE_PAID_TOPIC,
	RECOVERY_PROPOSED_TOPIC,
};
