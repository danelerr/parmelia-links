import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = resolve(rootDir, "contracts");
const reportPath = resolve(contractsDir, "lcov.info");
const thresholds = {
  "src/AccountFactoryV2.sol": { lines: 80, branches: 80, functions: 100 },
  "src/AccountWebAuthnV2.sol": { lines: 85, branches: 80, functions: 90 },
  "src/ParmeliaCrosschainRouter.sol": { lines: 90, branches: 80, functions: 90 },
  "src/ParmeliaPaymaster.sol": { lines: 85, branches: 80, functions: 90 },
  "src/ParmeliaPaymentRouter.sol": { lines: 90, branches: 80, functions: 90 },
};

execFileSync(
  process.env.FORGE_BIN ?? "forge",
  [
    "coverage",
    "--ir-minimum",
    "--report",
    "lcov",
    "--report-file",
    reportPath,
    "--exclude-tests",
    "--no-match-coverage",
    "script/",
  ],
  { cwd: contractsDir, stdio: "inherit" },
);

function parseLcov(contents) {
  const records = new Map();
  let current;

  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      current = {
        file: line.slice(3).replaceAll("\\", "/"),
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
      };
    } else if (current && line.startsWith("LF:")) {
      current.linesFound = Number(line.slice(3));
    } else if (current && line.startsWith("LH:")) {
      current.linesHit = Number(line.slice(3));
    } else if (current && line.startsWith("BRF:")) {
      current.branchesFound = Number(line.slice(4));
    } else if (current && line.startsWith("BRH:")) {
      current.branchesHit = Number(line.slice(4));
    } else if (current && line.startsWith("FNF:")) {
      current.functionsFound = Number(line.slice(4));
    } else if (current && line.startsWith("FNH:")) {
      current.functionsHit = Number(line.slice(4));
    } else if (current && line === "end_of_record") {
      records.set(current.file, current);
      current = undefined;
    }
  }

  return records;
}

function percentage(hit, found) {
  return found === 0 ? 100 : (hit / found) * 100;
}

const records = parseLcov(readFileSync(reportPath, "utf8"));
const rows = [];
let failed = false;

for (const [file, minimum] of Object.entries(thresholds)) {
  const record = records.get(file);
  if (!record) {
    console.error(`${file}: missing from LCOV report`);
    failed = true;
    continue;
  }

  const actual = {
    lines: percentage(record.linesHit, record.linesFound),
    branches: percentage(record.branchesHit, record.branchesFound),
    functions: percentage(record.functionsHit, record.functionsFound),
  };
  const failures = Object.entries(minimum)
    .filter(([metric, floor]) => actual[metric] + Number.EPSILON < floor)
    .map(([metric, floor]) => `${metric} ${actual[metric].toFixed(2)}% < ${floor}%`);

  if (failures.length > 0) {
    failed = true;
    console.error(`${file}: ${failures.join(", ")}`);
  }

  rows.push(
    `| ${file.replace("src/", "")} | ${actual.lines.toFixed(2)}% | ${actual.branches.toFixed(2)}% | ${actual.functions.toFixed(2)}% |`,
  );
}

const summary = [
  "## Contract coverage",
  "",
  "| Contract | Lines | Branches | Functions |",
  "|---|---:|---:|---:|",
  ...rows,
  "",
].join("\n");

console.log(summary);
if (failed) process.exitCode = 1;
