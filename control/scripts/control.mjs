import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = process.cwd();
const controlDir = path.join(root, "control");
const configPath = path.join(controlDir, "config.json");
const activeDir = path.join(controlDir, "claims", "active");
const archiveDir = path.join(controlDir, "claims", "archive");
const issuesDir = path.join(controlDir, "issues", "items");
const boardPath = path.join(controlDir, "issues", "BOARD.md");
const lockDir = path.join(controlDir, ".locks", "claims.lock");

function fail(message) {
  console.error("control: " + message);
  process.exitCode = 1;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function loadConfig() {
  return JSON.parse(await readFile(configPath, "utf8"));
}

function parseOptions(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error("Unexpected argument: " + token);
    const key = token.slice(2);
    const next = values[index + 1];
    const value = next && !next.startsWith("--") ? values[++index] : true;
    if (key in result) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

function valuesOf(value) {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireText(options, key) {
  const value = options[key];
  if (value === undefined || value === true || !String(value).trim()) {
    throw new Error("--" + key + " is required.");
  }
  return String(value).trim();
}

function normalizeArea(value) {
  let normalized = String(value).trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  normalized = normalized.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized || normalized === ".") return "**";
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("Claim area must be repository-relative: " + value);
  }
  return normalized;
}

function scopeBase(scope) {
  const wildcard = scope.search(/[*?[\]{}]/);
  return (wildcard === -1 ? scope : scope.slice(0, wildcard)).replace(/\/$/, "");
}

function areasOverlap(left, right) {
  if (left === "**" || right === "**" || left === right) return true;
  const a = scopeBase(left);
  const b = scopeBase(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

function claimsOverlap(left, right) {
  const area = left.areas.some((a) => right.areas.some((b) => areasOverlap(a, b)));
  const resource = left.resources.some((item) => right.resources.includes(item));
  return area || resource;
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = filePath + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temp, content, "utf8");
  await rename(temp, filePath);
}

async function withLock(callback) {
  const config = await loadConfig();
  await mkdir(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      acquired = true;
      await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString()
      }, null, 2));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const details = await stat(lockDir);
      const ageMinutes = (Date.now() - details.mtimeMs) / 60000;
      if (ageMinutes > config.lockStaleMinutes) {
        throw new Error("Claim mutex is stale (" + ageMinutes.toFixed(1) + " minutes). Inspect " + path.relative(root, lockDir) + "; do not delete it silently.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!acquired) throw new Error("Timed out waiting for the claim mutex.");
  const resolved = path.resolve(lockDir);
  if (!resolved.startsWith(path.resolve(controlDir) + path.sep)) {
    throw new Error("Refusing to use lock outside control directory: " + resolved);
  }
  try {
    return await callback();
  } finally {
    await rm(resolved, { recursive: true, force: true });
  }
}

async function activeClaims() {
  await mkdir(activeDir, { recursive: true });
  const files = (await readdir(activeDir)).filter((name) => name.endsWith(".json"));
  const claims = [];
  for (const name of files) {
    const filePath = path.join(activeDir, name);
    claims.push({ filePath, data: JSON.parse(await readFile(filePath, "utf8")) });
  }
  return claims;
}

function claimExpired(claim) {
  return Date.parse(claim.expiresAt) <= Date.now();
}

async function appendWorklog(kind, claim, detail) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const filePath = path.join(controlDir, "worklogs", year, month, year + "-" + month + "-" + day + ".md");
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!(await exists(filePath))) {
    await writeFile(filePath, "# NexusHarness worklog — " + year + "-" + month + "-" + day + "\n\n", "utf8");
  }
  const entry = [
    "## " + new Date().toISOString() + " — " + kind + ": " + claim.id,
    "",
    "- Agent: " + claim.agent,
    "- Task: " + claim.task,
    "- Areas: " + claim.areas.join(", "),
    "- Resources: " + (claim.resources.join(", ") || "none"),
    "- Version impact: " + claim.versionImpact,
    detail ? "\n" + detail.trim() : "",
    "",
    ""
  ].join("\n");
  await appendFile(filePath, entry, "utf8");
}

async function claimCommand(options) {
  const config = await loadConfig();
  const agent = requireText(options, "agent");
  const task = requireText(options, "task");
  const areas = valuesOf(options.area).map(normalizeArea);
  if (!areas.length) throw new Error("At least one --area is required.");
  const resources = valuesOf(options.resource).map((item) => item.toLowerCase());
  const issues = valuesOf(options.issue);
  const versionImpact = options.impact ? String(options.impact) : "none";
  if (!config.versionImpacts.includes(versionImpact)) {
    throw new Error("--impact must be one of: " + config.versionImpacts.join(", "));
  }

  await withLock(async () => {
    const active = await activeClaims();
    const candidate = { areas, resources };
    const conflicts = active.filter(({ data }) => claimsOverlap(candidate, data));
    if (conflicts.length) {
      const summary = conflicts.map(({ data }) => (claimExpired(data) ? "STALE " : "") + data.id + " (" + data.agent + ": " + data.areas.join(", ") + ")").join("; ");
      throw new Error("Claim overlaps active work: " + summary);
    }
    const now = new Date();
    const compactTime = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const safeAgent = agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const id = compactTime + "-" + safeAgent + "-" + randomUUID().slice(0, 8);
    const claim = {
      schemaVersion: 1,
      id,
      agent,
      task,
      areas,
      resources,
      issues,
      mode: "exclusive",
      versionImpact,
      status: "active",
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.claimTtlMinutes * 60000).toISOString()
    };
    await atomicWrite(path.join(activeDir, id + ".json"), JSON.stringify(claim, null, 2) + "\n");
    await appendWorklog("claim", claim, "");
    console.log(JSON.stringify(claim, null, 2));
  });
}

async function heartbeatCommand(options) {
  const id = requireText(options, "claim");
  const config = await loadConfig();
  await withLock(async () => {
    const active = await activeClaims();
    const record = active.find(({ data }) => data.id === id);
    if (!record) throw new Error("Active claim not found: " + id);
    if (claimExpired(record.data)) throw new Error("Claim is stale and cannot be renewed. Use takeover to create a new claim.");
    const now = new Date();
    record.data.heartbeatAt = now.toISOString();
    record.data.expiresAt = new Date(now.getTime() + config.claimTtlMinutes * 60000).toISOString();
    await atomicWrite(record.filePath, JSON.stringify(record.data, null, 2) + "\n");
    console.log("Renewed " + id + " until " + record.data.expiresAt);
  });
}

async function archiveInterruptedClaim(claim, status, reason) {
  const archivedAt = new Date().toISOString();
  const month = archivedAt.slice(0, 7);
  const destination = path.join(archiveDir, month, claim.id + ".md");
  const document = [
    "---",
    "id: " + escapeYaml(claim.id),
    "agent: " + escapeYaml(claim.agent),
    "status: " + escapeYaml(status),
    "createdAt: " + escapeYaml(claim.createdAt),
    "archivedAt: " + escapeYaml(archivedAt),
    "versionImpact: " + escapeYaml(claim.versionImpact),
    "areas: " + escapeYaml(claim.areas.join(", ")),
    "resources: " + escapeYaml(claim.resources.join(", ")),
    "issues: " + escapeYaml((claim.issues || []).join(", ")),
    "---",
    "",
    "# Interrupted claim: " + claim.task,
    "",
    "## Reason",
    "",
    reason,
    "",
    "## Unfinished work",
    "",
    "The previous agent did not release this claim. The takeover agent must inspect the workspace and linked issues before continuing.",
    ""
  ].join("\n");
  await atomicWrite(destination, document);
  return destination;
}

async function takeoverCommand(options) {
  const previousId = requireText(options, "claim");
  const agent = requireText(options, "agent");
  const reason = requireText(options, "reason");
  const config = await loadConfig();
  await withLock(async () => {
    const active = await activeClaims();
    const previous = active.find(({ data }) => data.id === previousId);
    if (!previous) throw new Error("Active claim not found: " + previousId);
    if (!claimExpired(previous.data)) throw new Error("Claim is not stale and cannot be taken over.");
    const now = new Date();
    const destination = await archiveInterruptedClaim(previous.data, "superseded", reason);
    await rm(previous.filePath);
    const compactTime = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const safeAgent = agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const id = compactTime + "-" + safeAgent + "-" + randomUUID().slice(0, 8);
    const claim = {
      ...previous.data,
      id,
      agent,
      status: "active",
      takeoverOf: previous.data.id,
      takeoverReason: reason,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.claimTtlMinutes * 60000).toISOString()
    };
    await atomicWrite(path.join(activeDir, id + ".json"), JSON.stringify(claim, null, 2) + "\n");
    await appendWorklog("takeover", claim, "- Superseded: " + previous.data.id + "\n- Reason: " + reason + "\n- Archive: " + path.relative(root, destination));
    console.log(JSON.stringify(claim, null, 2));
  });
}

function escapeYaml(value) {
  return JSON.stringify(String(value));
}

function parseIssue(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error("Issue file is missing YAML frontmatter.");
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      fields[key] = JSON.parse(raw);
    } catch {
      fields[key] = raw;
    }
  }
  return fields;
}

async function issueRecords() {
  await mkdir(issuesDir, { recursive: true });
  const files = (await readdir(issuesDir)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(files.map(async (name) => {
    const filePath = path.join(issuesDir, name);
    const content = await readFile(filePath, "utf8");
    return { filePath, content, fields: parseIssue(content) };
  }));
}

async function advanceLinkedIssues(claim, requestedStatus) {
  for (const issueId of claim.issues || []) {
    const filePath = path.join(issuesDir, issueId + ".md");
    if (!(await exists(filePath))) continue;
    const content = await readFile(filePath, "utf8");
    const fields = parseIssue(content);
    const nextStatus = fields.status === "done" ? "done" : requestedStatus;
    const updated = content
      .replace(/^status:\s*.*$/m, "status: " + escapeYaml(nextStatus))
      .replace(/^updatedAt:\s*.*$/m, "updatedAt: " + escapeYaml(new Date().toISOString()));
    await atomicWrite(filePath, updated);
  }
}

async function releaseCommand(options) {
  const id = requireText(options, "claim");
  const config = await loadConfig();
  const issueStatus = options["issue-status"] ? String(options["issue-status"]) : "verify";
  if (!config.issueStatuses.includes(issueStatus)) {
    throw new Error("--issue-status must be one of: " + config.issueStatuses.join(", "));
  }
  const notes = {
    summary: requireText(options, "summary"),
    files: requireText(options, "files"),
    verification: requireText(options, "verification"),
    worked: requireText(options, "worked"),
    didNotWork: requireText(options, "didnt"),
    unfinished: requireText(options, "unfinished")
  };
  await withLock(async () => {
    const active = await activeClaims();
    const record = active.find(({ data }) => data.id === id);
    if (!record) throw new Error("Active claim not found: " + id);
    if (claimExpired(record.data)) throw new Error("Claim is stale and cannot be released. Use takeover and record the interruption.");
    const claim = { ...record.data, status: "released", releasedAt: new Date().toISOString(), notes };
    const month = claim.releasedAt.slice(0, 7);
    const destination = path.join(archiveDir, month, claim.id + ".md");
    const document = [
      "---",
      "id: " + escapeYaml(claim.id),
      "agent: " + escapeYaml(claim.agent),
      "status: " + escapeYaml(claim.status),
      "createdAt: " + escapeYaml(claim.createdAt),
      "releasedAt: " + escapeYaml(claim.releasedAt),
      "versionImpact: " + escapeYaml(claim.versionImpact),
      "areas: " + escapeYaml(claim.areas.join(", ")),
      "resources: " + escapeYaml(claim.resources.join(", ")),
      "issues: " + escapeYaml((claim.issues || []).join(", ")),
      "---",
      "",
      "# " + claim.task,
      "",
      "## Summary",
      "",
      notes.summary,
      "",
      "## Files changed",
      "",
      notes.files,
      "",
      "## Verification",
      "",
      notes.verification,
      "",
      "## What worked",
      "",
      notes.worked,
      "",
      "## What did not work",
      "",
      notes.didNotWork,
      "",
      "## Unfinished work",
      "",
      notes.unfinished,
      ""
    ].join("\n");
    await atomicWrite(destination, document);
    await advanceLinkedIssues(claim, issueStatus);
    await rm(record.filePath);
    await appendWorklog("release", claim, "- Summary: " + notes.summary + "\n- Verification: " + notes.verification + "\n- Unfinished: " + notes.unfinished);
    console.log("Released " + id + " -> " + path.relative(root, destination));
  });
}

function boardContent(records, generatedAt = "TIMESTAMP") {
  const lines = [
    "# NexusHarness standing issue board",
    "",
    "Generated by control/scripts/control.mjs at " + generatedAt + ". Do not hand-edit this file.",
    ""
  ];
  const statuses = ["in_progress", "blocked", "ready", "backlog", "verify", "done"];
  for (const status of statuses) {
    lines.push("## " + status.replaceAll("_", " "), "");
    const matching = records.filter(({ fields }) => fields.status === status);
    if (!matching.length) {
      lines.push("_None._", "");
      continue;
    }
    lines.push("| ID | Severity | Target | Title | UX audit |", "| --- | --- | --- | --- | --- |");
    for (const { fields } of matching) {
      lines.push("| [" + fields.id + "](items/" + fields.id + ".md) | " + fields.severity + " | " + fields.targetRelease + " | " + fields.title + " | " + (fields.auditIds || "") + " |");
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

async function boardCommand() {
  const records = await issueRecords();
  await atomicWrite(boardPath, boardContent(records, new Date().toISOString()));
  console.log("Generated " + path.relative(root, boardPath) + " from " + records.length + " issues.");
}

async function statusCommand() {
  const records = await activeClaims();
  if (!records.length) {
    console.log("No active claims.");
  } else {
    for (const { data } of records) {
      const state = claimExpired(data) ? "STALE" : "ACTIVE";
      console.log(state + " " + data.id + " | " + data.agent + " | " + data.task + " | " + data.areas.join(", ") + " | expires " + data.expiresAt);
    }
  }
  if (await exists(boardPath)) console.log("Board: " + path.relative(root, boardPath));
}

async function verifyCommand() {
  const config = await loadConfig();
  const active = await activeClaims();
  const errors = [];
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      if (!claimExpired(active[left].data) && !claimExpired(active[right].data) && claimsOverlap(active[left].data, active[right].data)) {
        errors.push("Overlapping claims: " + active[left].data.id + " and " + active[right].data.id);
      }
    }
  }
  for (const { data } of active) {
    if (!config.versionImpacts.includes(data.versionImpact)) errors.push("Invalid version impact: " + data.id);
    if (!Array.isArray(data.areas) || !data.areas.length) errors.push("Claim has no areas: " + data.id);
    if (claimExpired(data)) errors.push("Stale active claim requires takeover: " + data.id);
  }

  const records = await issueRecords();
  for (const { filePath, fields } of records) {
    for (const key of ["id", "title", "severity", "status", "targetRelease", "updatedAt"]) {
      if (!fields[key]) errors.push(path.relative(root, filePath) + " is missing " + key);
    }
    if (fields.severity && !config.issueSeverities.includes(fields.severity)) errors.push(fields.id + " has invalid severity.");
    if (fields.status && !config.issueStatuses.includes(fields.status)) errors.push(fields.id + " has invalid status.");
  }
  if (!(await exists(boardPath))) {
    errors.push("Issue board is missing.");
  } else {
    const current = await readFile(boardPath, "utf8");
    const scrubTime = (text) => text.replace(/Generated by control\/scripts\/control\.mjs at .*?\. Do not/, "Generated by control/scripts/control.mjs at TIMESTAMP. Do not");
    if (scrubTime(current) !== boardContent(records, "TIMESTAMP")) errors.push("Issue board is stale; run npm run control:board.");
  }

  if (errors.length) {
    for (const error of errors) console.error("- " + error);
    throw new Error("Verification failed with " + errors.length + " issue(s).");
  }
  console.log("Control plane verified: " + active.length + " active claim(s), " + records.length + " issue(s).");
}

async function main() {
  if (!(await exists(path.join(root, "package.json"))) || !(await exists(configPath))) {
    throw new Error("Run this command from the NexusHarness repository root.");
  }
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (command === "claim") return claimCommand(options);
  if (command === "heartbeat") return heartbeatCommand(options);
  if (command === "takeover") return takeoverCommand(options);
  if (command === "release") return releaseCommand(options);
  if (command === "status") return statusCommand();
  if (command === "board") return boardCommand();
  if (command === "verify") return verifyCommand();
  throw new Error("Usage: control.mjs <status|claim|heartbeat|takeover|release|board|verify>");
}

main().catch((error) => fail(error.message || String(error)));
