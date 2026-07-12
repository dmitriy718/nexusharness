import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this gate through npm run test:package so the npm CLI can be located safely.");
const output = await run(process.execPath, [npmCli, "pack", "--dry-run", "--json"]);
const report = JSON.parse(output);
const artifact = report[0];
if (!artifact) throw new Error("npm pack did not report an artifact.");
if (artifact.id !== `${packageJson.name}@${packageJson.version}`) throw new Error(`Package identity mismatch: ${artifact.id}`);
if (artifact.size > 10_000_000) throw new Error(`Dry-run package is ${(artifact.size / 1_000_000).toFixed(2)} MB; the limit is 10 MB.`);

const files = new Set(artifact.files.map((entry) => entry.path.replaceAll("\\", "/")));
for (const required of ["package.json", "MIGRATION_V2.md", "docs/EMBEDDING_VECTOR_MEMORY_IMPLEMENTATION.md", "evaluation/memory-retrieval.json", "server/index.ts", "server/memory/vectorStore.ts", "src/main.tsx", "public/nexus-mark.svg", "public/manifest.webmanifest"]) {
  if (!files.has(required)) throw new Error(`Dry-run package is missing ${required}.`);
}
const forbidden = [...files].filter((file) =>
  file === ".env" || file.startsWith(".env.") && file !== ".env.example" ||
  file.startsWith(".nexusharness/") || file.startsWith("node_modules/") || file.startsWith("dist/visual-diffs/")
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
