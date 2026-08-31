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
	...passkeyColumns.map(([table, column, type]) =>
		evidenceValue("column", `${table}.${column}`, table, column, type, null)),
	...passkeyConstraints.map(([table, label, expectedSql]) =>
		evidenceValue("constraint", `${table}.${label}`, table, null, null, expectedSql)),
	...passkeyIndexes.map(([index, table, expectedSql]) =>
		evidenceValue("index", index, table, null, null, expectedSql)),
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
	`WHERE schema_entry.type = 'table' AND schema_entry.name = expected.table_name AND instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0)`,
	"WHEN expected.kind = 'column' AND expected.table_name = 'passkeys' THEN EXISTS(",
	"SELECT 1 FROM pragma_table_info('passkeys') AS column_info",
	"WHERE column_info.name = expected.column_name AND upper(column_info.type) = expected.expected_type)",
	"WHEN expected.kind = 'column' AND expected.table_name = 'webauthn_registration_challenges' THEN EXISTS(",
	"SELECT 1 FROM pragma_table_info('webauthn_registration_challenges') AS column_info",
	"WHERE column_info.name = expected.column_name AND upper(column_info.type) = expected.expected_type)",
	"WHEN expected.kind = 'constraint' THEN EXISTS(",
	"SELECT 1 FROM sqlite_schema AS schema_entry",
	`WHERE schema_entry.type = 'table' AND schema_entry.name = expected.table_name AND instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0)`,
	"WHEN expected.kind = 'index' THEN EXISTS(",
	"SELECT 1 FROM sqlite_schema AS schema_entry",
	`WHERE schema_entry.type = 'index' AND schema_entry.name = expected.item AND schema_entry.tbl_name = expected.table_name AND instr(${normalizedSchemaSql("schema_entry.sql")}, expected.expected_sql) > 0)`,
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
