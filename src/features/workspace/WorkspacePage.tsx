import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Copy, File, FileCode2, FileWarning, Folder, FolderOpen, FolderSearch, LoaderCircle, Paperclip, RefreshCw, Search, Undo2 } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { WorkspaceNode, WorkspacePreview } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, InlineAlert, PageHeader, formatDate } from "../../components/ui";
import { formatBytes, parentWorkspacePath, previewLines, runDraftForPath, workspaceBreadcrumbs } from "./workspaceModel";

export function WorkspacePage() {
  const { store, notify } = useHarness();
  const navigate = useNavigate();
  const [rootEntries, setRootEntries] = useState<WorkspaceNode[]>([]);
  const [children, setChildren] = useState<Record<string, WorkspaceNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<WorkspaceNode[]>([]);
  const [selected, setSelected] = useState<WorkspaceNode | null>(null);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setLocalError("");
    try {
      setRootEntries(await api<WorkspaceNode[]>("/api/workspace/entries?path=."));
      setChildren({});
      setExpanded(new Set());
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRoot(); }, [loadRoot]);
  useEffect(() => {
    if (!query.trim()) { setSearchResults([]); setSearching(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        setSearchResults(await api<WorkspaceNode[]>(`/api/workspace/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal }));
      } catch (caught) {
        if (!controller.signal.aborted) setLocalError(errorMessage(caught));
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);
  if (!store) return null;

  const loadDirectory = async (node: WorkspaceNode) => {
    if (node.type !== "directory") return;
    if (expanded.has(node.path)) {
      setExpanded((current) => { const next = new Set(current); next.delete(node.path); return next; });
      return;
    }
    if (!children[node.path]) {
      setLoadingPaths((current) => new Set(current).add(node.path));
      try {
        const entries = await api<WorkspaceNode[]>(`/api/workspace/entries?path=${encodeURIComponent(node.path)}`);
        setChildren((current) => ({ ...current, [node.path]: entries }));
      } catch (caught) {
        setLocalError(errorMessage(caught));
      } finally {
        setLoadingPaths((current) => { const next = new Set(current); next.delete(node.path); return next; });
      }
    }
    setExpanded((current) => new Set(current).add(node.path));
  };

  const selectNode = async (node: WorkspaceNode) => {
    setSelected(node);
    setPreview(null);
    setLocalError("");
    if (node.type === "directory") return;
    if (node.blocked || node.type === "symlink") return;
    setPreviewing(true);
    try {
      setPreview(await api<WorkspacePreview>(`/api/workspace/preview?path=${encodeURIComponent(node.path)}`));
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setPreviewing(false);
    }
  };

  const copyPath = async () => {
    if (!selected) return;
    try { await navigator.clipboard.writeText(selected.path); notify("Copied workspace-relative path."); }
    catch (caught) { notify(`Copy failed: ${errorMessage(caught)}`, "danger"); }
  };

  const attachToRun = () => {
    if (!selected || selected.type !== "file") return;
    window.sessionStorage.setItem("nexusharness.runDraft", runDraftForPath(selected.path));
    navigate("/runs?mode=focus");
  };

  const chooseBreadcrumb = async (path: string) => {
    if (path === ".") { setSelected(null); return; }
    const name = path.split("/").at(-1) ?? path;
    const node: WorkspaceNode = { name, path, type: "directory" };
    setSelected(node);
    if (!expanded.has(path)) await loadDirectory(node);
  };

  return <div className="page workspace-page">
    <PageHeader eyebrow="Safe local boundary" title="Workspace" detail="Browse and preview files under the configured root without granting mutation access." actions={<button className="button secondary" disabled={loading} onClick={() => void loadRoot()}><RefreshCw className={loading ? "spin" : ""} />Refresh root</button>} />
    {localError && <InlineAlert tone="danger" title="Workspace action failed">{localError}</InlineAlert>}
    <div className="workspace-boundary"><FolderOpen /><span><small>Configured root</small><code>{store.settings.workspaceRoot}</code></span><strong>Read-only browser</strong></div>
    <div className="workspace-shell workspace-shell-v2">
      <section className="workspace-tree-panel"><header><div><p className="eyebrow">Explorer</p><h2>{store.settings.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}</h2></div><span>{rootEntries.length} root entries</span></header><label className="search-control full-search"><Search /><span className="sr-only">Search workspace</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search up to 5,000 paths" /></label><div className="workspace-tree" role="region" aria-label="Workspace files and folders">{loading ? <div className="tree-skeleton" role="status" aria-label="Loading workspace files">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div> : query.trim() ? <SearchResults results={searchResults} searching={searching} selected={selected?.path} select={selectNode} /> : rootEntries.length ? rootEntries.map((node) => <TreeNodeV2 node={node} depth={0} key={node.path} selected={selected?.path} expanded={expanded} children={children} loadingPaths={loadingPaths} toggle={loadDirectory} select={selectNode} />) : <EmptyState icon={<FolderSearch />} title="Workspace is empty" detail="No files or directories were returned from the configured root." />}</div></section>
      <section className="workspace-preview workspace-preview-v2">{selected ? <><nav className="workspace-breadcrumbs" aria-label="Selected path">{workspaceBreadcrumbs(selected.path).map((crumb, index, all) => <React.Fragment key={crumb.path}><button onClick={() => void chooseBreadcrumb(crumb.path)}>{crumb.name}</button>{index < all.length - 1 && <ChevronRight />}</React.Fragment>)}</nav><header><span className="metric-icon metric-cyan">{selected.type === "directory" ? <FolderOpen /> : selected.type === "symlink" ? <FileWarning /> : <FileCode2 />}</span><div><p className="eyebrow">{selected.type}</p><h2>{selected.name}</h2><code>{selected.path}</code></div></header><div className="workspace-actions"><button className="button secondary" onClick={() => void copyPath()}><Copy />Copy path</button>{selected.type === "file" && <button className="button primary" onClick={attachToRun}><Paperclip />Attach to new run</button>}<button className="button quiet" onClick={() => void chooseBreadcrumb(parentWorkspacePath(selected.path))}><Undo2 />Reveal parent</button></div><dl className="path-details"><div><dt>Size</dt><dd>{preview ? formatBytes(preview.size) : selected.size !== undefined ? formatBytes(selected.size) : "Directory"}</dd></div><div><dt>Modified</dt><dd>{preview?.modifiedAt || selected.modifiedAt ? formatDate(preview?.modifiedAt ?? selected.modifiedAt) : "—"}</dd></div>{preview && <><div><dt>Language</dt><dd>{preview.language}</dd></div><div><dt>Preview</dt><dd>{preview.truncated ? "First 200 KB" : "Complete file"}</dd></div></>}</dl>{selected.blocked || selected.type === "symlink" ? <InlineAlert tone="warning" title="Symbolic link preview blocked">The browser shows this entry but does not follow it because its target can change outside the visible workspace tree.</InlineAlert> : previewing ? <div className="preview-loading" role="status"><LoaderCircle className="spin" />Loading bounded preview…</div> : preview ? <FilePreview preview={preview} /> : selected.type === "directory" ? <div className="preview-placeholder"><FolderOpen /><h3>Directory selected</h3><p>Expand it in the tree to load only its immediate children.</p></div> : null}</> : <EmptyState icon={<Folder />} title="Select a path" detail="Choose a file for a bounded read-only preview or a directory to inspect its metadata." />}</section>
    </div>
  </div>;
}

function TreeNodeV2({ node, depth, selected, expanded, children, loadingPaths, toggle, select }: { node: WorkspaceNode; depth: number; selected?: string; expanded: Set<string>; children: Record<string, WorkspaceNode[]>; loadingPaths: Set<string>; toggle: (node: WorkspaceNode) => Promise<void>; select: (node: WorkspaceNode) => Promise<void> }) {
  const open = expanded.has(node.path);
  const directory = node.type === "directory";
  const keyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" && directory && !open) { event.preventDefault(); void toggle(node); }
    if (event.key === "ArrowLeft" && directory && open) { event.preventDefault(); void toggle(node); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const items = [...document.querySelectorAll<HTMLButtonElement>(".workspace-node-button")]; const index = items.indexOf(event.currentTarget); items[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus(); }
  };
  return <div><button aria-expanded={directory ? open : undefined} aria-current={selected === node.path ? "true" : undefined} className={`workspace-node-button node-${node.type}${selected === node.path ? " selected" : ""}`} style={{ "--depth": depth } as React.CSSProperties} onKeyDown={keyboard} onClick={() => void select(node)} onDoubleClick={() => void toggle(node)}>{directory ? <ChevronRight className={open ? "open" : ""} /> : <span className="tree-spacer" />}{node.type === "directory" ? open ? <FolderOpen /> : <Folder /> : node.type === "symlink" ? <FileWarning /> : <File />}<span>{node.name}</span>{loadingPaths.has(node.path) ? <LoaderCircle className="spin" aria-label="Loading folder" /> : node.type === "file" && node.size !== undefined ? <small>{formatBytes(node.size)}</small> : null}</button>{directory && open && <div className="workspace-node-children">{(children[node.path] ?? []).map((child) => <TreeNodeV2 key={child.path} node={child} depth={depth + 1} selected={selected} expanded={expanded} children={children} loadingPaths={loadingPaths} toggle={toggle} select={select} />)}{children[node.path]?.length === 0 && <span className="empty-directory" style={{ "--depth": depth + 1 } as React.CSSProperties}>Empty directory</span>}</div>}</div>;
}

function SearchResults({ results, searching, selected, select }: { results: WorkspaceNode[]; searching: boolean; selected?: string; select: (node: WorkspaceNode) => Promise<void> }) {
  if (searching) return <div className="preview-loading"><LoaderCircle className="spin" />Searching bounded workspace index…</div>;
  if (!results.length) return <EmptyState icon={<FolderSearch />} title="No matching paths" detail="Try a broader file, folder, or relative path." />;
  return <div className="workspace-search-results">{results.map((node) => <button aria-current={selected === node.path ? "true" : undefined} className={selected === node.path ? "selected" : ""} key={node.path} onClick={() => void select(node)}>{node.type === "directory" ? <Folder /> : node.type === "symlink" ? <FileWarning /> : <File />}<span><strong>{node.name}</strong><small>{node.path}</small></span><em>{node.type}</em></button>)}</div>;
}

function FilePreview({ preview }: { preview: WorkspacePreview }) {
  if (preview.binary) return <div className="preview-placeholder"><FileWarning /><h3>Binary preview unavailable</h3><p>{formatBytes(preview.size)} · content is not rendered as text.</p></div>;
  return <div className="code-preview" aria-label={`Read-only preview of ${preview.name}`}><header><span>{preview.name}</span><em>{preview.truncated ? "truncated at 200 KB" : `${previewLines(preview.content).length} lines`}</em></header><pre>{previewLines(preview.content).map((line) => <span key={line.number}><i>{line.number}</i><code>{line.text || " "}</code></span>)}</pre></div>;
}
