import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PASSKEY_SECURITY_SCHEMA_ITEMS } from "./app-d1-security-evidence.mjs";

const source = readFileSync(resolve(import.meta.dirname, "preflight-phase3-app-remote.mjs"), "utf8");
const d1EvidenceSource = readFileSync(resolve(import.meta.dirname, "app-d1-security-evidence.mjs"), "utf8");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

assert(source.includes("remoteMutationPerformed: false"),
	"Phase 3 App preflight must state that it does not mutate remote state");
assert(source.includes("realMailboxUsed: false"),
	"Phase 3 App preflight must state that it does not use a real mailbox");
assert(source.includes("requiresAuthorizedRealMagicLinkProof: true"),
	"Phase 3 App preflight must keep real magic-link proof as a separate authorized gate");

for (const forbidden of [
	/"d1"\s*,\s*"migrations"\s*,\s*"apply"/u,
	/"secret"\s*,\s*"put"/u,
	/"queues"\s*,\s*"create"/u,
	/"(?:deploy|delete|rollback)"\s*,/u,
	/\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX)|ALTER\s+TABLE|REPLACE\s+INTO|CREATE\s+(?:TABLE|INDEX)|VACUUM)\b/iu,
]) {
	assert(!forbidden.test(`${source}\n${d1EvidenceSource}`),
		`Phase 3 App preflight contains a mutating operation: ${forbidden}`);
}

assert((source.match(/"--command"/gu) ?? []).length === 1,
	"Phase 3 App preflight must execute exactly one guarded D1 statement");
assert(source.includes("APP_D1_SECURITY_EVIDENCE_QUERY"),
	"Phase 3 App preflight must use the shared migration and schema evidence query");
assert(d1EvidenceSource.includes("pragma_table_info"),
	"D1 security evidence must inspect real remote table columns");
for (const evidence of [
	"webauthn_registration_challenges.expected_rp_id",
	"passkeys.metadata_updated_at",
	"passkeys.sign_count",
	"webauthn_authentication_challenges",
	"passkeys.sign_count.non_negative",
	"idx_webauthn_authentication_active",
	"idx_webauthn_authentication_expiry",
	"webauthn_registration_challenges.credential_device_type.allowed",
	"webauthn_registration_challenges.credential_backed_up.allowed",
	"webauthn_registration_challenges.authenticator_attachment.allowed",
	"passkeys.credential_device_type.allowed",
	"passkeys.credential_backed_up.allowed",
	"passkeys.authenticator_attachment.allowed",
	"idx_passkeys_uid_rp_active",
]) {
	assert(PASSKEY_SECURITY_SCHEMA_ITEMS.includes(evidence),
		`D1 security evidence is incomplete: ${evidence}`);
}
assert(source.includes('"app-passkey-schema-0037"'),
	"Phase 3 App preflight must expose a dedicated Passkey schema gate through 0037");
assert(source.includes('"deployments", "status", "--name", workerName, "--json"'),
	"Phase 3 App preflight must discover every active Worker version");
assert(source.includes('"versions", "view", activeVersion.version_id'),
	"Phase 3 App preflight must inspect bindings on every active Worker version");
assert(source.includes('bindingValue(version, "PASSKEY_RP_ID") === passkeyRpId'),
	"Phase 3 App preflight must verify the deployed stable RP ID");
assert(source.includes('bindingValue(version, "PASSKEY_ALLOWED_ORIGINS") === passkeyAllowedOrigins'),
	"Phase 3 App preflight must verify the deployed WebAuthn origin allowlist");
assert(source.includes('"app-webauthn-bindings"'),
	"Phase 3 App preflight must expose a dedicated WebAuthn binding gate");
assert((source.match(/method:\s*"POST"/gu) ?? []).length === 1,
	"Phase 3 App preflight must contain exactly one non-GET HTTP probe");
assert(source.includes('body: JSON.stringify({ email: "invalid" })'),
	"The only POST probe must use an invalid email rejected before delivery or persistence");
assert(source.includes('routeProof.status === 400 && routeProof.body?.error_code === "INVALID_EMAIL"'),
	"The deployed route proof must require the fail-closed invalid-email response");
assert(source.includes('scriptSources.includes("https://apis.google.com")'),
	"Remote preflight must prove that production CSP allows the Firebase Google popup loader");
assert(source.includes('frameSources.includes("https://accounts.google.com")'),
	"Remote preflight must prove that production CSP allows the Google account frame");
assert(source.includes('"app-google-auth-csp"'),
	"Remote preflight must expose a dedicated Google authentication CSP gate");
assert(!source.includes("sendOobCode"),
	"Remote preflight must never call Firebase email delivery");
assert(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(source),
	"Remote preflight must not embed or use a real mailbox");

console.log("Phase 3 App remote preflight is read-only and cannot send a real magic link.");
