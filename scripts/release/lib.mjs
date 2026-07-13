import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

export function assertVersion(version) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!semver.test(version)) throw new Error(`Invalid Semantic Version: ${version}`);
  return version;
}

export function expectedTag(version) {
  return `v${assertVersion(version)}`;
}

export function npmDistTag(version) {
  assertVersion(version);
  return version.includes("-") ? "next" : "latest";
}

export function changelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = changelog.match(new RegExp(`^## \\[${escaped}\\](?: - [^\\r\\n]+)?\\r?\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, "m"));
  if (!match) throw new Error(`CHANGELOG.md has no released section for ${version}.`);
  return `# NexusHarness ${version}\n\n${match[1].trim()}\n`;
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    if (options.inherit) {
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve("") : reject(new Error(`${command} exited with ${code}.`)));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

export async function npmCli(args, options = {}) {
  const executable = process.env.npm_execpath;
  if (!executable) throw new Error("npm_execpath is unavailable. Run release commands through npm.");
  return run(process.execPath, [executable, ...args], options);
}

export async function git(args) {
  return String(await run("git", args)).trim();
}
