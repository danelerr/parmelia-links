const passkeyColumns = [
	["passkeys", "sign_count", "INTEGER"],
	["webauthn_registration_challenges", "expected_rp_id", "TEXT"],
	["webauthn_registration_challenges", "aaguid", "TEXT"],
	["webauthn_registration_challenges", "provider_name", "TEXT"],
	["webauthn_registration_challenges", "credential_device_type", "TEXT"],
	["webauthn_registration_challenges", "credential_backed_up", "INTEGER"],
	["webauthn_registration_challenges", "authenticator_attachment", "TEXT"],
	["passkeys", "rp_id", "TEXT"],
	["passkeys", "aaguid", "TEXT"],
	["passkeys", "provider_name", "TEXT"],
	["passkeys", "credential_device_type", "TEXT"],
	["passkeys", "credential_backed_up", "INTEGER"],
	["passkeys", "authenticator_attachment", "TEXT"],
	["passkeys", "metadata_updated_at", "TEXT"],
];

const passkeyTables = [
	["webauthn_authentication_challenges",
		"createtablewebauthn_authentication_challenges(idtextprimarykey,uidtextnotnull,challengetextnotnull,expected_origintextnotnull,expected_rp_idtextnotnull,consumed_attext,expires_attextnotnull,created_attextnotnull)strict"],
];

const passkeyConstraints = [
	["passkeys", "sign_count.non_negative", "check(sign_count>=0)"],
	["webauthn_registration_challenges", "credential_device_type.allowed",
		"check(credential_device_typeisnullorcredential_device_typein('singledevice','multidevice'))"],
	["webauthn_registration_challenges", "credential_backed_up.allowed",
		"check(credential_backed_upisnullorcredential_backed_upin(0,1))"],
	["webauthn_registration_challenges", "authenticator_attachment.allowed",
		"check(authenticator_attachmentisnullorauthenticator_attachmentin('platform','cross-platform'))"],
	["passkeys", "credential_device_type.allowed",
		"check(credential_device_typeisnullorcredential_device_typein('singledevice','multidevice'))"],
	["passkeys", "credential_backed_up.allowed",
		"check(credential_backed_upisnullorcredential_backed_upin(0,1))"],
	["passkeys", "authenticator_attachment.allowed",
		"check(authenticator_attachmentisnullorauthenticator_attachmentin('platform','cross-platform'))"],
];

const passkeyIndexes = [
	["idx_webauthn_authentication_active", "webauthn_authentication_challenges",
		"createindexidx_webauthn_authentication_activeonwebauthn_authentication_challenges(uid,created_atdesc)whereconsumed_atisnull"],
	["idx_webauthn_authentication_expiry", "webauthn_authentication_challenges",
		"createindexidx_webauthn_authentication_expiryonwebauthn_authentication_challenges(expires_at)"],
	["idx_passkeys_uid_rp_active", "passkeys",
		"createindexidx_passkeys_uid_rp_activeonpasskeys(uid,rp_id,last_used_atdesc)whererevoked_atisnull"],
];

const multichainTables = [
	["account_security_versions", null],
	["user_chain_accounts", null],
	["chain_indexer_wallet_registry_outbox", null],
];

const multichainColumns = [
	["account_security_versions", "desired_version", "INTEGER"],
	["user_chain_accounts", "chain_id", "INTEGER"],
	["user_chain_accounts", "chain_key", "TEXT"],
	["user_chain_accounts", "wallet_address", "TEXT"],
	["user_chain_accounts", "is_home", "INTEGER"],
	["user_chain_accounts", "status", "TEXT"],
	["user_chain_accounts", "security_status", "TEXT"],
	["user_chain_accounts", "security_version_applied", "INTEGER"],
	["account_operations", "chain_id", "INTEGER"],
	["account_operations", "chain_key", "TEXT"],
	["pending_payments", "chain_id", "INTEGER"],
	["pending_payments", "chain_key", "TEXT"],
	["ledger", "chain_id", "INTEGER"],
	["chain_indexer_wallet_registry_outbox", "chain_id", "INTEGER"],
	["chain_indexer_wallet_registry_outbox", "chain_key", "TEXT"],
	["chain_indexer_wallet_registry_outbox", "wallet_address", "TEXT"],
	["chain_indexer_wallet_registry_outbox", "status", "TEXT"],
];

const multichainConstraints = [
	["account_security_versions", "desired_version.positive", "check(desired_version>0)"],
	["user_chain_accounts", "is_home.boolean", "check(is_homein(0,1))"],
	["user_chain_accounts", "status.allowed", "check(statusin('deploying','active','failed','disabled'))"],
	["user_chain_accounts", "security_status.allowed", "check(security_statusin('current','needs_sync','syncing','failed'))"],
	["chain_indexer_wallet_registry_outbox", "status.allowed", "check(statusin('pending','failed'))"],
];

const multichainIndexes = [
	["idx_user_chain_accounts_chain_status", "user_chain_accounts", "createindexidx_user_chain_accounts_chain_statusonuser_chain_accounts(chain_id,status,wallet_address)"],
	["idx_account_operations_active_uid_kind_chain", "account_operations", "createuniqueindexidx_account_operations_active_uid_kind_chainonaccount_operations(uid,kind,chain_id)wherestatusin('prepared','submitted','needs_review')"],
	["idx_account_operations_chain_status_updated", "account_operations", "createindexidx_account_operations_chain_status_updatedonaccount_operations(chain_id,status,updated_at)"],
	["idx_pending_payments_chain_status", "pending_payments", "createindexidx_pending_payments_chain_statusonpending_payments(chain_id,status,created_at)"],
	["idx_pending_security_sync_active", "pending_payments", "createuniqueindexidx_pending_security_sync_activeonpending_payments(uid,chain_id,currency)wherecurrency='passkey_sync'andstatusin('prepared','submitting','submitted')"],
	["idx_chain_indexer_wallet_registry_due", "chain_indexer_wallet_registry_outbox", "createindexidx_chain_indexer_wallet_registry_dueonchain_indexer_wallet_registry_outbox(chain_id,status,next_attempt_at,updated_at)"],
];

const multichainTriggers = [
	"trg_security_version_passkey_insert",
	"trg_security_version_passkey_update",
	"trg_home_state_chain_account_insert",
	"trg_home_state_chain_account_update",
	"trg_chain_indexer_registry_account_insert",
	"trg_chain_indexer_registry_account_update",
].map((name) => [name, `createtrigger${name}`]);

function sqlLiteral(value) {
	return `'${value.replaceAll("'", "''")}'`;
}

function nullableSqlLiteral(value) {
	return value === null ? "NULL" : sqlLiteral(value);
}

function normalizedSchemaSql(expression) {
	return `lower(replace(replace(replace(replace(${expression}, ' ', ''), char(9), ''), char(10), ''), char(13), ''))`;
}

function evidenceValue(kind, item, table, column, type, expectedSql) {
	return `(${[
		kind,
		item,
		table,
		column,
		type,
		expectedSql,
	].map(nullableSqlLiteral).join(", ")})`;
}

const expectedEvidenceValues = [
	...passkeyTables.map(([table, expectedSql]) =>
		evidenceValue("table", table, table, null, null, expectedSql)),
	...multichainTables.map(([table, expectedSql]) =>
		evidenceValue("table", table, table, null, null, expectedSql)),
	...passkeyColumns.map(([table, column, type]) =>
		evidenceValue("column", `${table}.${column}`, table, column, type, null)),
	...multichainColumns.map(([table, column, type]) =>
		evidenceValue("column", `${table}.${column}`, table, column, type, null)),
	...passkeyConstraints.map(([table, label, expectedSql]) =>
		evidenceValue("constraint", `${table}.${label}`, table, null, null, expectedSql)),
	...multichainConstraints.map(([table, label, expectedSql]) =>
		evidenceValue("constraint", `${table}.${label}`, table, null, null, expectedSql)),
	...passkeyIndexes.map(([index, table, expectedSql]) =>
		evidenceValue("index", index, table, null, null, expectedSql)),
	...multichainIndexes.map(([index, table, expectedSql]) =>
		evidenceValue("index", index, table, null, null, expectedSql)),
	...multichainTriggers.map(([trigger, expectedSql]) =>
		evidenceValue("trigger", trigger, null, null, null, expectedSql)),
];

export const APP_D1_SECURITY_EVIDENCE_QUERY = [
	"WITH expected(kind, item, table_name, column_name, expected_type, expected_sql) AS (",
	`VALUES ${expectedEvidenceValues.join(", ")}`,
	"), evidence(kind, item, present) AS (",
	"SELECT 'migration', name, 1 FROM d1_migrations",
	"UNION ALL",
	"SELECT expected.kind, expected.item, CASE",
	"WHEN expected.kind = 'table' THEN EXISTS(",
	"SELECT 1 FROM sqlite_schema AS schema_entry",
	`WHERE schema_entry.type = 'table' AND schema_entry.name = expected.table_name AND (expected.expected_sql IS NULL OR instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0))`,
	"WHEN expected.kind = 'column' THEN EXISTS(",
	"SELECT 1 FROM pragma_table_info(expected.table_name) AS column_info",
	"WHERE column_info.name = expected.column_name AND upper(column_info.type) = expected.expected_type)",
	"WHEN expected.kind = 'constraint' THEN EXISTS(",
	"SELECT 1 FROM sqlite_schema AS schema_entry",
	`WHERE schema_entry.type = 'table' AND schema_entry.name = expected.table_name AND instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0)`,
	"WHEN expected.kind = 'index' THEN EXISTS(",
	"SELECT 1 FROM sqlite_schema AS schema_entry",
	`WHERE schema_entry.type = 'index' AND schema_entry.name = expected.item AND schema_entry.tbl_name = expected.table_name AND instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0)`,
	"WHEN expected.kind = 'trigger' THEN EXISTS(",
	"SELECT 1 FROM sqlite_schema AS schema_entry",
	`WHERE schema_entry.type = 'trigger' AND schema_entry.name = expected.item AND instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0)`,
	"ELSE 0 END FROM expected",
") SELECT kind, item, present FROM evidence ORDER BY kind, item;",
].join(" ");

export const PASSKEY_SECURITY_SCHEMA_EVIDENCE = Object.freeze([
	...passkeyTables.map(([table]) => Object.freeze({ kind: "table", item: table })),
	...passkeyColumns.map(([table, column]) => Object.freeze({
		kind: "column",
		item: `${table}.${column}`,
	})),
	...passkeyConstraints.map(([table, label]) => Object.freeze({
		kind: "constraint",
		item: `${table}.${label}`,
	})),
	...passkeyIndexes.map(([index]) => Object.freeze({ kind: "index", item: index })),
]);

export const PASSKEY_SECURITY_SCHEMA_ITEMS = Object.freeze(
	PASSKEY_SECURITY_SCHEMA_EVIDENCE.map(({ item }) => item),
);

export const APP_MULTICHAIN_SCHEMA_EVIDENCE = Object.freeze([
	...multichainTables.map(([table]) => Object.freeze({ kind: "table", item: table })),
	...multichainColumns.map(([table, column]) => Object.freeze({
		kind: "column",
		item: `${table}.${column}`,
	})),
	...multichainConstraints.map(([table, label]) => Object.freeze({
		kind: "constraint",
		item: `${table}.${label}`,
	})),
	...multichainIndexes.map(([index]) => Object.freeze({ kind: "index", item: index })),
	...multichainTriggers.map(([trigger]) => Object.freeze({ kind: "trigger", item: trigger })),
]);

export const APP_MULTICHAIN_SCHEMA_ITEMS = Object.freeze(
	APP_MULTICHAIN_SCHEMA_EVIDENCE.map(({ item }) => item),
);

export function d1EvidenceRows(payload) {
	const operations = Array.isArray(payload) ? payload : [payload];
	return operations.flatMap((operation) => Array.isArray(operation?.results) ? operation.results : [])
		.filter((row) => row && typeof row.kind === "string" && typeof row.item === "string");
}

export function appliedMigrationNamesFromEvidence(rows) {
	return rows
		.filter((row) => row.kind === "migration" && Number(row.present) === 1)
		.map((row) => row.item);
}

export function missingPasskeySecuritySchemaEvidence(rows) {
	const present = new Set(rows
		.filter((row) => Number(row.present) === 1)
		.map((row) => `${row.kind}:${row.item}`));
	return PASSKEY_SECURITY_SCHEMA_EVIDENCE
		.filter(({ kind, item }) => !present.has(`${kind}:${item}`))
		.map(({ item }) => item);
}

export function assertPasskeySecuritySchemaEvidence(rows) {
	const missing = missingPasskeySecuritySchemaEvidence(rows);
	if (missing.length > 0) {
		throw new Error(
			`Refusing App deployment: remote GATOPAGO_DB is missing Passkey Security v2 schema evidence: ${missing.join(", ")}.`,
		);
	}
	return { schemaEvidence: PASSKEY_SECURITY_SCHEMA_ITEMS.length };
}

export function missingAppMultichainSchemaEvidence(rows) {
	const present = new Set(rows
		.filter((row) => Number(row.present) === 1)
		.map((row) => `${row.kind}:${row.item}`));
	return APP_MULTICHAIN_SCHEMA_EVIDENCE
		.filter(({ kind, item }) => !present.has(`${kind}:${item}`))
		.map(({ item }) => item);
}

export function assertAppMultichainSchemaEvidence(rows) {
	const missing = missingAppMultichainSchemaEvidence(rows);
	if (missing.length > 0) {
		throw new Error(
			`Refusing App deployment: remote GATOPAGO_DB is missing Phase 4A multichain schema evidence: ${missing.join(", ")}.`,
		);
	}
	return { multichainSchemaEvidence: APP_MULTICHAIN_SCHEMA_ITEMS.length };
}
