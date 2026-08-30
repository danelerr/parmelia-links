import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "preflight-phase3-app-remote.mjs"), "utf8");

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
	/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|CREATE|VACUUM)\b/iu,
]) {
	assert(!forbidden.test(source), `Phase 3 App preflight contains a mutating operation: ${forbidden}`);
}

assert((source.match(/"--command"/gu) ?? []).length === 1,
	"Phase 3 App preflight must execute exactly one guarded D1 statement");
assert(source.includes("SELECT name FROM d1_migrations WHERE name = '${expectedMigration}';"),
	"Phase 3 App preflight must limit D1 access to the migration-presence SELECT");
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
