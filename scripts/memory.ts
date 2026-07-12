import path from "node:path";
import { dataDir, loadStore, saveStore } from "../server/store.js";
import { createEmbeddingProvider } from "../server/memory/providers.js";
import { resolveMemoryConfiguration } from "../server/memory/config.js";
import { getMemorySubsystem } from "../server/memory/subsystem.js";

const [command = "diagnostics", ...rawArguments] = process.argv.slice(2);
const argumentsMap = parseArguments(rawArguments);
const subsystem = await getMemorySubsystem();
const store = await loadStore();

if (command === "diagnostics") {
  console.log(JSON.stringify(subsystem.diagnostics(store), null, 2));
} else if (command === "health") {
  const configuration = resolveMemoryConfiguration(store.settings);
  const provider = createEmbeddingProvider(configuration.embeddings, { modelCacheDirectory: path.join(dataDir, "embedding-models") });
  console.log(JSON.stringify({ vectorStore: subsystem.vectorStore?.health(), provider: await provider.health() }, null, 2));
} else if (command === "migrate") {
  if (!subsystem.vectorStore) throw new Error("Vector store is unavailable.");
  const target = numberArgument(argumentsMap, "target");
  const rollback = numberArgument(argumentsMap, "rollback-to");
  if (target !== undefined && rollback !== undefined) throw new Error("Use either --target or --rollback-to, not both.");
  if (rollback !== undefined) subsystem.vectorStore.rollbackMigrations(rollback);
  else subsystem.vectorStore.migrate(target);
  console.log(JSON.stringify(subsystem.vectorStore.health(), null, 2));
} else if (command === "backfill" || command === "reembed") {
  const report = await subsystem.backfill(store, {
    jobId: stringArgument(argumentsMap, "job"),
    dryRun: booleanArgument(argumentsMap, "dry-run"),
    batchSize: numberArgument(argumentsMap, "batch-size"),
    rateLimitPerSecond: numberArgument(argumentsMap, "rate-limit"),
    namespace: stringArgument(argumentsMap, "namespace"),
    kind: stringArgument(argumentsMap, "kind") as "context" | "snippet" | "retrospective" | undefined,
    updatedAfter: stringArgument(argumentsMap, "updated-after"),
    staleOnly: !booleanArgument(argumentsMap, "all"),
    force: command === "reembed" || booleanArgument(argumentsMap, "force") || booleanArgument(argumentsMap, "all"),
    activateOnComplete: command === "backfill" ? booleanArgument(argumentsMap, "activate") : false
  });
  await saveStore(store);
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 2;
} else if (command === "activate") {
  const generationId = requiredArgument(argumentsMap, "generation");
  if (!subsystem.reembedding) throw new Error("Vector store is unavailable.");
  subsystem.reembedding.cutover(store.memory, store.settings, generationId);
  console.log(JSON.stringify(subsystem.diagnostics(store), null, 2));
} else if (command === "rollback") {
  if (!subsystem.reembedding) throw new Error("Vector store is unavailable.");
  console.log(JSON.stringify(subsystem.reembedding.rollback(store.settings), null, 2));
} else if (command === "prune") {
  if (!subsystem.vectorStore) throw new Error("Vector store is unavailable.");
  const generationId = requiredArgument(argumentsMap, "generation");
  if (!booleanArgument(argumentsMap, "confirm")) throw new Error("Generation removal requires --confirm true after rollback acceptance.");
  subsystem.vectorStore.deleteGeneration(generationId, booleanArgument(argumentsMap, "remove-rollback-reference"));
  console.log(JSON.stringify(subsystem.diagnostics(store), null, 2));
} else {
  throw new Error("Usage: tsx scripts/memory.ts <diagnostics|health|migrate|backfill|reembed|activate|rollback|prune> [--option value]");
}

function parseArguments(values: string[]): Map<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    parsed.set(key, next && !next.startsWith("--") ? values[++index] : true);
  }
  return parsed;
}

function stringArgument(values: Map<string, string | true>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" ? value : undefined;
}

function requiredArgument(values: Map<string, string | true>, key: string): string {
  const value = stringArgument(values, key);
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function numberArgument(values: Map<string, string | true>, key: string): number | undefined {
  const value = stringArgument(values, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a non-negative number.`);
  return parsed;
}

function booleanArgument(values: Map<string, string | true>, key: string): boolean {
  const value = values.get(key);
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} must be true or false.`);
}
