import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const [packageLock, shrinkwrap] = await Promise.all([
  readFile(path.join(root, "package-lock.json"), "utf8"),
  readFile(path.join(root, "npm-shrinkwrap.json"), "utf8")
]);
if (packageLock !== shrinkwrap) throw new Error("package-lock.json and the published npm-shrinkwrap.json have drifted; regenerate them together before release.");
if (packageJson.license !== "Apache-2.0") throw new Error(`Package license must be Apache-2.0, received ${packageJson.license}.`);
if (packageJson.bin?.nexus !== "dist-server/cli/index.js") throw new Error("Package must map the nexus executable to dist-server/cli/index.js.");
for (const dependency of ["better-sqlite3@12.11.1", "esbuild@0.28.1", "onnxruntime-node@1.24.3", "protobufjs@7.6.5", "sharp@0.34.5"]) {
  if (packageJson.allowScripts?.[dependency] !== true) throw new Error(`Install script review policy is missing pinned approval for ${dependency}.`);
}
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this gate through npm run test:package so the npm CLI can be located safely.");
const output = await run(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"]);
const report = JSON.parse(output);
const artifact = report[0];
if (!artifact) throw new Error("npm pack did not report an artifact.");
if (artifact.id !== `${packageJson.name}@${packageJson.version}`) throw new Error(`Package identity mismatch: ${artifact.id}`);
if (artifact.size > 10_000_000) throw new Error(`Dry-run package is ${(artifact.size / 1_000_000).toFixed(2)} MB; the limit is 10 MB.`);

const files = new Set(artifact.files.map((entry) => entry.path.replaceAll("\\", "/")));
for (const required of ["package.json", "npm-shrinkwrap.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "dist/index.html", "dist/nexus-mark.svg", "dist/manifest.webmanifest", "dist-server/cli/index.js", "dist-server/cli/lifecycle.js", "dist-server/server/index.js", "dist-server/server/paths.js", "dist-server/server/memory/vectorStore.js"]) {
  if (!files.has(required)) throw new Error(`Dry-run package is missing ${required}.`);
}
const forbidden = [...files].filter((file) =>
  file === ".env" || file.startsWith(".env.") && file !== ".env.example" ||
  file.startsWith(".nexusharness/") || file.startsWith("node_modules/") || file.startsWith("dist/visual-diffs/") ||
  file.startsWith("src/") || file.startsWith("tests/") || file.startsWith("control/") || file.startsWith("server/") || file.startsWith("cli/")
);
if (forbidden.length) throw new Error(`Dry-run package contains forbidden paths: ${forbidden.join(", ")}`);
console.log(`Package dry run verified ${artifact.id}: ${artifact.entryCount} files, ${(artifact.size / 1_000_000).toFixed(2)} MB.`);

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`npm pack --dry-run failed (${code}): ${stderr || stdout}`));
    });
  });
}
