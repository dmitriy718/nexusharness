import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const files = {
  package: path.join(root, "package.json"),
  lock: path.join(root, "package-lock.json"),
  marketplace: path.join(root, "marketplace.json")
};

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function atomicJson(filePath, value) {
  const temporary = filePath + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filePath);
}

function validateVersion(version) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!semver.test(version)) throw new Error("package.json contains an invalid Semantic Version: " + version);
}

async function state() {
  const [packageJson, lockJson, marketplaceJson] = await Promise.all([
    readJson(files.package),
    readJson(files.lock),
    readJson(files.marketplace)
  ]);
  validateVersion(packageJson.version);
  return { packageJson, lockJson, marketplaceJson, version: packageJson.version };
}

async function check() {
  const { lockJson, marketplaceJson, version } = await state();
  const mismatches = [];
  if (lockJson.version !== version) mismatches.push("package-lock.json top-level version is " + lockJson.version);
  if (lockJson.packages?.[""]?.version !== version) mismatches.push("package-lock.json root package version is " + lockJson.packages?.[""]?.version);
  if (marketplaceJson.version !== version) mismatches.push("marketplace.json version is " + marketplaceJson.version);
  if (mismatches.length) {
    throw new Error("Version mismatch; expected " + version + ":\n- " + mismatches.join("\n- "));
  }
  console.log("Version identity verified: " + version);
}

async function sync() {
  const { lockJson, marketplaceJson, version } = await state();
  lockJson.version = version;
  lockJson.packages[""].version = version;
  marketplaceJson.version = version;
  await Promise.all([
    atomicJson(files.lock, lockJson),
    atomicJson(files.marketplace, marketplaceJson)
  ]);
  console.log("Synchronized package-lock.json and marketplace.json to " + version);
}

const command = process.argv[2];
if (command === "check") {
  await check();
} else if (command === "sync") {
  await sync();
} else {
  throw new Error("Usage: node scripts/version.mjs <check|sync>");
}
