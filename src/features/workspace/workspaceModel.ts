export function formatBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function workspaceBreadcrumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  return [{ name: "Workspace", path: "." }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }))];
}

export function parentWorkspacePath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length <= 1 ? "." : parts.slice(0, -1).join("/");
}

export function runDraftForPath(path: string): string {
  return `Use the workspace file \`${path}\` as task context.\n\nObjective: `;
}

export function previewLines(content: string, limit = 2500): Array<{ number: number; text: string }> {
  return content.split(/\r?\n/).slice(0, limit).map((text, index) => ({ number: index + 1, text }));
}
