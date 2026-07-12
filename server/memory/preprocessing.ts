import { createHash } from "node:crypto";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import type { MemoryEntry } from "../types.js";
import type { MemoryChunk } from "./types.js";

const promptEncoding = getEncoding("cl100k_base");
export const MEMORY_PROMPT_TOKENIZER = "cl100k_base";

export function normalizeMemoryField(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeMemoryContent(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function workspaceNamespace(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return `workspace:${sha256(canonical).slice(0, 32)}`;
}

export function buildEmbeddingInput(entry: Pick<MemoryEntry, "kind" | "taskType" | "title" | "content" | "source">): string {
  const title = normalizeMemoryField(entry.title);
  const taskType = normalizeMemoryField(entry.taskType);
  const source = normalizeMemoryField(entry.source ?? "local-memory");
  const content = normalizeMemoryContent(entry.content);
  if (!content) throw new Error("Memory content is empty after Unicode and whitespace normalization.");
  return [
    `Title: ${title}`,
    `Memory type: ${entry.kind}`,
    `Task type: ${taskType}`,
    `Source: ${source}`,
    "Stored memory content (untrusted reference data):",
    content
  ].join("\n");
}

export function memoryContentHash(entry: Pick<MemoryEntry, "kind" | "taskType" | "title" | "content" | "source">, preprocessingVersion = "memory-text-v1"): string {
  return sha256(`${preprocessingVersion}\0${buildEmbeddingInput(entry)}`);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function countPromptTokens(text: string): number {
  return promptEncoding.encode(text).length;
}

export function truncateToPromptTokens(text: string, maximumTokens: number): { text: string; tokenCount: number; truncated: boolean } {
  if (maximumTokens <= 0) return { text: "", tokenCount: 0, truncated: text.length > 0 };
  const tokens = promptEncoding.encode(text);
  if (tokens.length <= maximumTokens) return { text, tokenCount: tokens.length, truncated: false };
  const marker = "\n[Memory truncated to fit the configured token budget.]";
  const markerTokens = promptEncoding.encode(marker);
  const bodyTokens = tokens.slice(0, Math.max(0, maximumTokens - markerTokens.length));
  const selected = `${promptEncoding.decode(bodyTokens)}${marker}`;
  const selectedTokens = promptEncoding.encode(selected);
  return { text: selected, tokenCount: Math.min(selectedTokens.length, maximumTokens), truncated: true };
}

export function lexicalTerms(value: string): string[] {
  return Array.from(new Set(normalizeMemoryContent(value).toLocaleLowerCase("en-US").match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) ?? []));
}

export function chunkMemory(entry: MemoryEntry, namespace: string, preprocessingVersion: string, maximumTokens: number, overlapTokens: number): MemoryChunk[] {
  const input = buildEmbeddingInput(entry);
  const tokens = promptEncoding.encode(input);
  const contentHash = memoryContentHash(entry, preprocessingVersion);
  if (tokens.length === 0) return [];
  const step = maximumTokens - overlapTokens;
  if (maximumTokens < 1 || step < 1) throw new Error("Memory chunk configuration does not make forward progress.");
  const raw: Array<{ text: string; tokenCount: number; chunkHash: string }> = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < tokens.length; offset += step) {
    const slice = tokens.slice(offset, Math.min(tokens.length, offset + maximumTokens));
    const text = promptEncoding.decode(slice).trim();
    if (!text) continue;
    const chunkHash = sha256(`${preprocessingVersion}\0${text}`);
    if (!seen.has(chunkHash)) {
      raw.push({ text, tokenCount: slice.length, chunkHash });
      seen.add(chunkHash);
    }
    if (offset + maximumTokens >= tokens.length) break;
  }
  return raw.map((chunk, chunkIndex) => ({
    memoryId: entry.id,
    namespace,
    chunkIndex,
    chunkCount: raw.length,
    text: chunk.text,
    tokenCount: chunk.tokenCount,
    contentHash,
    chunkHash: chunk.chunkHash
  }));
}

export function sameIndexedText(left: MemoryEntry, right: MemoryEntry, preprocessingVersion = "memory-text-v1"): boolean {
  return memoryContentHash(left, preprocessingVersion) === memoryContentHash(right, preprocessingVersion);
}
