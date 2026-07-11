import React, { useEffect, useMemo, useState } from "react";
import { File, FileCode2, Folder, FolderOpen, FolderSearch, RefreshCw, Search } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { WorkspaceNode } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, InlineAlert, PageHeader } from "../../components/ui";

export function WorkspacePage() {
  const { store } = useHarness();
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WorkspaceNode | null>(null);

  const load = async () => {
    setLoading(true);
    setLocalError("");
    try {
      setTree(await api<WorkspaceNode[]>("/api/workspace/tree"));
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  const filtered = useMemo(() => query ? filterTree(tree, query.toLowerCase()) : tree, [query, tree]);
  if (!store) return null;

  return (
    <div className="page workspace-page">
      <PageHeader eyebrow="Safe local boundary" title="Workspace" detail="Explore the configured root and understand the paths available to local tools." actions={<button className="button secondary" disabled={loading} onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} />Refresh tree</button>} />
      {localError && <InlineAlert title="Workspace could not be loaded">{localError}</InlineAlert>}
      <div className="workspace-shell">
        <section className="workspace-tree-panel">
          <header><div><p className="eyebrow">Explorer</p><h2>{store.settings.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}</h2></div></header>
          <label className="search-control full-search"><Search /><span className="sr-only">Search workspace</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files and folders" /></label>
          <div className="workspace-tree" role="tree" aria-label="Workspace files">
            {loading ? <div className="tree-skeleton">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div> : filtered.length ? filtered.map((node) => <TreeNode node={node} depth={0} key={node.path} selected={selected?.path} onSelect={setSelected} />) : <EmptyState icon={<FolderSearch />} title="No matching paths" detail="Try a broader file or folder name." />}
          </div>
        </section>
        <section className="workspace-preview">
          {selected ? <>
            <header><span className="metric-icon metric-cyan">{selected.type === "directory" ? <FolderOpen /> : <FileCode2 />}</span><div><p className="eyebrow">{selected.type}</p><h2>{selected.name}</h2></div></header>
            <dl className="path-details"><div><dt>Relative path</dt><dd><code>{selected.path}</code></dd></div><div><dt>Available action</dt><dd>{selected.type === "directory" ? "Browse descendants" : "Attach path as task context"}</dd></div>{selected.children && <div><dt>Visible children</dt><dd>{selected.children.length}</dd></div>}</dl>
            <div className="preview-placeholder"><FileCode2 /><h3>Read-only preview foundation</h3><p>File content preview will use the same bounded server read contract and redaction rules as approval review.</p></div>
          </> : <EmptyState icon={<Folder />} title="Select a path" detail="Choose a file or directory to inspect its local workspace context." />}
        </section>
      </div>
    </div>
  );
}

function TreeNode({ node, depth, selected, onSelect }: { node: WorkspaceNode; depth: number; selected?: string; onSelect: (node: WorkspaceNode) => void }) {
  if (node.type === "directory") {
    return <details className="tree-directory" style={{ "--depth": depth } as React.CSSProperties}><summary onClick={() => onSelect(node)}><Folder /><span>{node.name}</span><small>{node.children?.length ?? 0}</small></summary>{node.children?.map((child) => <TreeNode node={child} depth={depth + 1} selected={selected} onSelect={onSelect} key={child.path} />)}</details>;
  }
  return <button role="treeitem" className={"tree-file" + (selected === node.path ? " selected" : "")} style={{ "--depth": depth } as React.CSSProperties} onClick={() => onSelect(node)}><File /><span>{node.name}</span></button>;
}

function filterTree(nodes: WorkspaceNode[], query: string): WorkspaceNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? filterTree(node.children, query) : [];
    if (node.name.toLowerCase().includes(query) || children.length) return [{ ...node, children }];
    return [];
  });
}
