import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = resolve(rootDir, "contracts");
const trackedLayouts = [
  {
    contract: "AccountWebAuthnV2",
    snapshot: resolve(contractsDir, "storage-layout", "AccountWebAuthnV2.json"),
  },
  {
    contract: "ParmeliaPaymaster",
    snapshot: resolve(contractsDir, "storage-layout", "ParmeliaPaymaster.json"),
  },
];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function inspectLayout(contract) {
  const output = execFileSync(
    process.env.FORGE_BIN ?? "forge",
    ["inspect", contract, "storage-layout", "--json", "--force"],
    { cwd: contractsDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(output);
}

function normalizeType(layout, typeId, stack = []) {
  const descriptor = layout.types[typeId];
  if (!descriptor) {
    throw new Error(`Storage type ${typeId} is missing from the compiler output`);
  }
  if (stack.includes(typeId)) {
    return { recursiveType: descriptor.label };
  }

  const nextStack = [...stack, typeId];
  const normalized = {
    encoding: descriptor.encoding,
    label: descriptor.label,
    numberOfBytes: descriptor.numberOfBytes,
  };

  for (const field of ["base", "key", "value"]) {
    if (descriptor[field]) {
      normalized[field] = normalizeType(layout, descriptor[field], nextStack);
    }
  }

  if (descriptor.members) {
    normalized.members = descriptor.members.map((member) => ({
      label: member.label,
      slot: String(member.slot),
      offset: member.offset,
      type: normalizeType(layout, member.type, nextStack),
    }));
  }

  return normalized;
}

function normalizeEntry(layout, entry) {
  return {
    label: entry.label,
    slot: String(entry.slot),
    offset: entry.offset,
    type: normalizeType(layout, entry.type),
  };
}

function checkAppendOnly(contract, baseline, current) {
  if (current.storage.length < baseline.storage.length) {
    throw new Error(
      `${contract}: current layout has ${current.storage.length} entries; snapshot has ${baseline.storage.length}`,
    );
  }

  for (let index = 0; index < baseline.storage.length; index += 1) {
    const expected = normalizeEntry(baseline, baseline.storage[index]);
    const actual = normalizeEntry(current, current.storage[index]);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${contract}: incompatible storage entry at index ${index}\n` +
          `Expected: ${JSON.stringify(expected, null, 2)}\n` +
          `Actual:   ${JSON.stringify(actual, null, 2)}`,
      );
    }
  }

  return current.storage.length - baseline.storage.length;
}

let failed = false;
for (const tracked of trackedLayouts) {
  try {
    const additions = checkAppendOnly(
      tracked.contract,
      loadJson(tracked.snapshot),
      inspectLayout(tracked.contract),
    );
    const suffix = additions === 0 ? "unchanged" : `${additions} append-only addition(s)`;
    console.log(`${tracked.contract}: compatible (${suffix})`);
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failed) process.exitCode = 1;
