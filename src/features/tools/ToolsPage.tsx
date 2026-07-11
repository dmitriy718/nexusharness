import React, { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Boxes, Check, ChevronRight, Code2, FileCode2, Filter, Network, Plus, RefreshCw, Search, ShieldCheck, Square, Terminal, Trash2, Wrench, X } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { McpServer, McpTool } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, InlineAlert, PageHeader, StatusBadge, formatDate } from "../../components/ui";
import { discoveryChunks, filterMcpServers, meaningfulArguments, parseStdioArguments, schemaSummary, toolCategory, toolRisk } from "./toolModel";

type DiscoveryResponse = { servers: McpServer[]; range: { start: number; end: number }; scanned: number };
type ScanState = { started: boolean; running: boolean; canceled: boolean; scanned: number; total: number; current: string; found: McpServer[] };
type ServerFormState = { name: string; endpoint: string; transport: "http" | "stdio"; command: string; args: string[]; rawArgs: string; advanced: boolean; enabled: boolean };
const emptyScan: ScanState = { started: false, running: false, canceled: false, scanned: 0, total: 0, current: "", found: [] };
const localTools = [
  { name: "file_list", title: "List workspace files", risk: "read", detail: "Lists paths inside the configured workspace boundary.", approval: false },
  { name: "file_read", title: "Read workspace file", risk: "read", detail: "Reads bounded UTF-8 content inside the workspace.", approval: false },
  { name: "file_write", title: "Write workspace file", risk: "write", detail: "Shows a diff and hashes before changing content.", approval: true },
  { name: "file_delete", title: "Delete workspace path", risk: "write", detail: "Warns about file or recursive directory deletion.", approval: true },
  { name: "shell_exec", title: "Run shell command", risk: "execute", detail: "Runs with current OS permissions in the workspace root.", approval: true }
];

export function ToolsPage() {
  const { store, refresh, notify } = useHarness();
  const [tab, setTab] = useState<"mcp" | "local">("mcp");
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [localError, setLocalError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<Record<string, string>>({});
  const [scan, setScan] = useState<ScanState>(emptyScan);
  const scanController = useRef<AbortController | null>(null);
  const [form, setForm] = useState<ServerFormState>({ name: "", endpoint: "http://127.0.0.1:3001", transport: "http", command: "", args: [""], rawArgs: "[]", advanced: false, enabled: true });
  if (!store) return null;

  const filtered = filterMcpServers(store.mcpServers, query, risk);
  const selected = filtered.find((server) => server.id === selectedId) ?? filtered[0] ?? null;
  const enabledTools = store.mcpServers.filter((server) => server.enabled).flatMap((server) => server.tools.filter((tool) => tool.enabled)).length;

  const add = async () => {
    setBusy("add");
    setLocalError("");
    try {
      const args = form.transport === "stdio" ? (form.advanced ? parseStdioArguments(form.rawArgs) : meaningfulArguments(form.args)) : [];
      const server = await api<McpServer>("/api/mcp", { method: "POST", body: JSON.stringify({ name: form.name, endpoint: form.transport === "stdio" ? "stdio" : form.endpoint, transport: form.transport, command: form.transport === "stdio" ? form.command : undefined, args, enabled: form.enabled }) });
      await refresh();
      setSelectedId(server.id);
      setFormOpen(false);
      setForm({ name: "", endpoint: "http://127.0.0.1:3001", transport: "http", command: "", args: [""], rawArgs: "[]", advanced: false, enabled: true });
      notify(server.status === "online" ? "MCP server connected and inspected." : "MCP server saved with a connection error.", server.status === "online" ? "success" : "info");
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const discover = async () => {
    const chunks = discoveryChunks(store.settings.mcpPortStart, store.settings.mcpPortEnd);
    const controller = new AbortController();
    scanController.current = controller;
    setLocalError("");
    setScan({ started: true, running: true, canceled: false, scanned: 0, total: store.settings.mcpPortEnd - store.settings.mcpPortStart + 1, current: "", found: [] });
    let scanned = 0;
    const found: McpServer[] = [];
    try {
      for (const chunk of chunks) {
        if (controller.signal.aborted) break;
        setScan((current) => ({ ...current, current: `${chunk.start}-${chunk.end}` }));
        const result = await api<DiscoveryResponse>("/api/mcp/discover", { method: "POST", signal: controller.signal, body: JSON.stringify(chunk) });
        scanned += result.scanned;
        found.push(...result.servers);
        setScan((current) => ({ ...current, scanned, found: [...found] }));
      }
      if (!controller.signal.aborted) {
        await refresh();
        setScan((current) => ({ ...current, running: false, current: "" }));
        notify(`Discovery scanned ${scanned.toLocaleString()} ports and added ${found.length} new server${found.length === 1 ? "" : "s"}.`, "info");
      } else {
        await refresh();
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        setScan((current) => ({ ...current, running: false, canceled: true, current: "" }));
      } else {
        setScan((current) => ({ ...current, running: false, current: "" }));
        setLocalError(errorMessage(caught));
      }
    } finally {
      scanController.current = null;
    }
  };

  const cancelScan = () => {
    scanController.current?.abort();
    setScan((current) => ({ ...current, running: false, canceled: true, current: "" }));
  };

  const update = async (server: McpServer, next: McpServer, message: string) => {
    setBusy(`update:${server.id}`);
    setLocalError("");
    try {
      await api(`/api/mcp/${server.id}`, { method: "PUT", body: JSON.stringify(next) });
      await refresh();
      notify(message);
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const refreshServer = async (server: McpServer) => {
    setBusy(`refresh:${server.id}`);
    setLocalError("");
    try {
      await api(`/api/mcp/${server.id}/refresh`, { method: "POST" });
      await refresh();
      setRefreshedAt((current) => ({ ...current, [server.id]: new Date().toISOString() }));
      notify(`${server.name} capability inventory refreshed.`);
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  const bulkTools = async (server: McpServer, enabled: boolean) => {
    if (enabled && !window.confirm(`Enable all ${server.tools.length} tools from ${server.name}? Review execute, write, and network capabilities before continuing.`)) return;
    await update(server, { ...server, tools: server.tools.map((tool) => ({ ...tool, enabled })) }, `${enabled ? "Enabled" : "Disabled"} all tools from ${server.name}.`);
  };

  const remove = async (server: McpServer) => {
    if (!window.confirm(`Remove MCP server ${server.name} and its ${server.tools.length} discovered tools?`)) return;
    setBusy(`remove:${server.id}`);
    try {
      await api(`/api/mcp/${server.id}`, { method: "DELETE" });
      await refresh();
      setSelectedId("");
      notify("MCP server removed.", "info");
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setBusy("");
    }
  };

  return <div className="page tools-page">
    <PageHeader eyebrow="Capability layer" title="Tools & MCP" detail="Inspect every capability available to Executor agents and preserve explicit local safety policy." actions={tab === "mcp" ? <><button className="button secondary" disabled={scan.running} onClick={() => void discover()}><RefreshCw className={scan.running ? "spin" : ""} />Scan {store.settings.mcpPortStart}-{store.settings.mcpPortEnd}</button><button className="button primary" onClick={() => setFormOpen(true)}><Plus />Add server</button></> : undefined} />
    <div className="feature-tabs" role="tablist" aria-label="Tool configuration view"><button role="tab" aria-selected={tab === "mcp"} className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}><Network />MCP servers <span>{store.mcpServers.length}</span></button><button role="tab" aria-selected={tab === "local"} className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}><ShieldCheck />Local tools & policy <span>{localTools.length}</span></button></div>
    {localError && <InlineAlert tone="danger" title="Tool action failed">{localError}</InlineAlert>}
    {tab === "local" ? <LocalPolicy approvalMode={store.settings.approvalMode} /> : <>
      {scan.started && <DiscoveryProgress scan={scan} range={`${store.settings.mcpPortStart}-${store.settings.mcpPortEnd}`} cancel={cancelScan} close={() => setScan(emptyScan)} />}
      {formOpen && <ServerForm form={form} setForm={setForm} busy={busy === "add"} error={localError} add={add} close={() => setFormOpen(false)} />}
      <div className="tool-stats metric-grid"><article className="metric-card metric-violet"><span className="metric-icon"><Boxes /></span><div><p>Servers</p><strong>{store.mcpServers.length}</strong><small>configured endpoints</small></div></article><article className="metric-card metric-cyan"><span className="metric-icon"><Wrench /></span><div><p>Tools</p><strong>{store.mcpServers.flatMap((server) => server.tools).length}</strong><small>inspected capabilities</small></div></article><article className="metric-card metric-green"><span className="metric-icon"><Check /></span><div><p>Available</p><strong>{enabledTools}</strong><small>server and tool enabled</small></div></article></div>
      <section className="section-block tool-browser">
        <div className="tool-filterbar"><label className="search-control full-search"><Search /><span className="sr-only">Search servers and tools</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, description, category, endpoint" /></label><label className="select-control"><Filter /><span className="sr-only">Tool risk</span><select value={risk} onChange={(event) => setRisk(event.target.value)}><option value="all">All risks</option><option value="read">Read</option><option value="write">Write</option><option value="execute">Execute</option><option value="network">Network</option></select></label></div>
        {filtered.length ? <div className="tool-browser-grid"><nav className="server-nav" aria-label="MCP servers">{filtered.map((server) => <button className={server.id === selected?.id ? "active" : ""} key={server.id} onClick={() => setSelectedId(server.id)}><span className="metric-icon metric-blue">{server.transport === "stdio" ? <Terminal /> : <Network />}</span><span><strong>{server.name}</strong><small>{server.tools.length} matching · {server.transport}</small></span><StatusBadge status={server.status} /><ChevronRight /></button>)}</nav>{selected && <ServerDetail server={selected} original={store.mcpServers.find((item) => item.id === selected.id) ?? selected} busy={busy.includes(selected.id)} refreshedAt={refreshedAt[selected.id]} update={update} refresh={() => void refreshServer(selected)} bulk={bulkTools} remove={() => void remove(selected)} />}</div> : <EmptyState icon={<Boxes />} title={store.mcpServers.length ? "No matching capabilities" : "No MCP servers connected"} detail={store.mcpServers.length ? "Try a different search or risk filter." : "Connect a server manually or scan the configured localhost range in bounded chunks."} />}
      </section>
    </>}
  </div>;
}

function DiscoveryProgress({ scan, range, cancel, close }: { scan: ScanState; range: string; cancel: () => void; close: () => void }) {
  const percent = scan.total ? Math.round(scan.scanned / scan.total * 100) : 0;
  return <section className="section-block discovery-progress" aria-live="polite"><header><div><p className="eyebrow">Localhost discovery</p><h2>{scan.running ? `Scanning ${scan.current}` : scan.canceled ? "Scan canceled" : "Scan complete"}</h2><p>Configured range {range} · bounded requests of at most 500 ports</p></div>{scan.running ? <button className="button danger-quiet" onClick={cancel}><Square />Cancel scan</button> : <button className="icon-button" aria-label="Close discovery result" onClick={close}><X /></button>}</header><div className="scan-progress-track"><span style={{ width: `${percent}%` }} /></div><div className="scan-progress-meta"><span><strong>{scan.scanned.toLocaleString()}</strong> / {scan.total.toLocaleString()} ports · {percent}%</span><span><strong>{scan.found.length}</strong> new server{scan.found.length === 1 ? "" : "s"}</span></div>{!scan.running && <div className="scan-results">{scan.found.length ? scan.found.map((server) => <span key={server.id}><Check />{server.name} · {server.tools.length} tools</span>) : <span><Network />No new MCP servers responded in the scanned range.</span>}</div>}</section>;
}

function ServerForm({ form, setForm, busy, error, add, close }: { form: ServerFormState; setForm: React.Dispatch<React.SetStateAction<ServerFormState>>; busy: boolean; error: string; add: () => Promise<void>; close: () => void }) {
  return <section className="section-block connection-form"><div className="section-heading"><div><p className="eyebrow">New MCP connection</p><h2>Connect and inspect</h2></div><button className="icon-button" aria-label="Close server form" onClick={close}><X /></button></div><div className="form-grid"><Field label="Display name" htmlFor="mcp-name"><input id="mcp-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Local filesystem tools" /></Field><Field label="Transport" htmlFor="mcp-transport"><select id="mcp-transport" value={form.transport} onChange={(event) => setForm((current) => ({ ...current, transport: event.target.value as "http" | "stdio" }))}><option value="http">Streamable HTTP</option><option value="stdio">stdio process</option></select></Field>{form.transport === "http" ? <Field label="Endpoint URL" htmlFor="mcp-endpoint"><input id="mcp-endpoint" value={form.endpoint} onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))} /></Field> : <><Field label="Command" htmlFor="mcp-command"><input id="mcp-command" value={form.command} onChange={(event) => setForm((current) => ({ ...current, command: event.target.value }))} placeholder="npx" /></Field><div className="stdio-arguments"><div><strong>Arguments</strong><button className="button quiet" onClick={() => setForm((current) => ({ ...current, advanced: !current.advanced, rawArgs: JSON.stringify(meaningfulArguments(current.args), null, 2) }))}><Code2 />{form.advanced ? "Guided rows" : "Advanced JSON"}</button></div>{form.advanced ? <textarea aria-label="Raw JSON arguments" rows={7} value={form.rawArgs} onChange={(event) => setForm((current) => ({ ...current, rawArgs: event.target.value }))} /> : form.args.map((argument, index) => <div className="argument-row" key={index}><input aria-label={`Argument ${index + 1}`} value={argument} onChange={(event) => setForm((current) => ({ ...current, args: current.args.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} placeholder={index === 0 ? "-y" : "Argument value"} /><button className="icon-button" aria-label={`Remove argument ${index + 1}`} disabled={form.args.length === 1} onClick={() => setForm((current) => ({ ...current, args: current.args.filter((_, itemIndex) => itemIndex !== index) }))}><X /></button></div>)}{!form.advanced && <button className="button quiet" onClick={() => setForm((current) => ({ ...current, args: [...current.args, ""] }))}><Plus />Add argument</button>}</div></>}</div>{error && <InlineAlert tone="danger" title="Server could not connect">{error}</InlineAlert>}<div className="form-actions"><button className="button quiet" onClick={close}>Cancel</button><button className="button primary" disabled={!form.name.trim() || busy || (form.transport === "stdio" ? !form.command.trim() : !form.endpoint.trim())} onClick={() => void add()}><Network />{busy ? "Connecting and inspecting…" : "Connect and inspect"}</button></div></section>;
}

function ServerDetail({ server, original, busy, refreshedAt, update, refresh, bulk, remove }: { server: McpServer; original: McpServer; busy: boolean; refreshedAt?: string; update: (server: McpServer, next: McpServer, message: string) => Promise<void>; refresh: () => void; bulk: (server: McpServer, enabled: boolean) => Promise<void>; remove: () => void }) {
  const toggleTool = (tool: McpTool) => update(original, { ...original, tools: original.tools.map((item) => item.name === tool.name ? { ...item, enabled: !item.enabled } : item) }, `${tool.name} ${tool.enabled ? "disabled" : "enabled"}.`);
  return <article className="server-detail"><header><span className="metric-icon metric-blue">{server.transport === "stdio" ? <Terminal /> : <Network />}</span><div><p className="eyebrow">{server.transport} server</p><h2>{server.name}</h2><code>{server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.endpoint}</code></div><StatusBadge status={server.status} /></header><div className="server-facts"><span><small>Capability inventory</small><strong>{original.tools.length} tools · {original.tools.filter((tool) => tool.enabled).length} enabled</strong></span><span><small>Last refresh</small><strong>{refreshedAt ? formatDate(refreshedAt) : "This session: initial load"}</strong></span><label className="server-enable-control"><span>{original.enabled ? "Server enabled" : "Server disabled"}</span><span className="switch-control"><input type="checkbox" disabled={busy} checked={original.enabled} onChange={() => void update(original, { ...original, enabled: !original.enabled }, `${original.name} ${original.enabled ? "disabled" : "enabled"}.`)} /><span /></span></label></div>{server.lastError && <InlineAlert tone="danger" title="Server error">{server.lastError}</InlineAlert>}<div className="server-actions"><button className="button secondary" disabled={busy} onClick={refresh}><RefreshCw className={busy ? "spin" : ""} />Refresh tools</button><button className="button quiet" disabled={busy || !original.tools.length} onClick={() => void bulk(original, true)}>Enable all</button><button className="button quiet" disabled={busy || !original.tools.length} onClick={() => void bulk(original, false)}>Disable all</button></div><div className="tool-detail-list">{server.tools.map((tool) => { const schema = schemaSummary(tool.inputSchema); const actual = original.tools.find((item) => item.name === tool.name) ?? tool; return <article className="tool-detail-row" key={tool.name}><span className="tool-symbol"><Wrench /></span><div><header><strong>{tool.name}</strong><span>{toolCategory(tool)}</span><StatusBadge status={toolRisk(tool)} /></header><p>{tool.description || "No description provided by this server."}</p><details><summary>{schema.label} <ChevronRight /></summary><pre>{JSON.stringify(tool.inputSchema ?? { type: "object", properties: {} }, null, 2)}</pre></details></div><label className="tool-toggle"><span className="sr-only">Enable {tool.name}</span><input type="checkbox" checked={actual.enabled} disabled={busy || !original.enabled} onChange={() => void toggleTool(actual)} /></label></article>; })}</div><footer><span>Changes save per control with in-flight protection.</span><button className="button danger-quiet" disabled={busy} onClick={remove}><Trash2 />Remove server</button></footer></article>;
}

function LocalPolicy({ approvalMode }: { approvalMode: boolean }) {
  return <><section className={`policy-banner ${approvalMode ? "safe" : "warning"}`}><span>{approvalMode ? <ShieldCheck /> : <AlertTriangle />}</span><div><p className="eyebrow">Execution policy</p><h2>{approvalMode ? "Approval gates are enabled" : "Approval gates are disabled"}</h2><p>{approvalMode ? "Write, delete, and shell operations pause for contextual operator review." : "High-impact local tools can execute without an approval pause. Review this setting before running agents."}</p></div><Link className="button secondary" to="/settings">Review safety settings</Link></section><section className="section-block"><div className="section-heading"><div><p className="eyebrow">Built-in capabilities</p><h2>{localTools.length} local tools</h2></div><span className="section-note">Fixed harness capabilities · workspace constrained</span></div><div className="local-tool-grid">{localTools.map((tool) => <article key={tool.name}><span className="tool-symbol">{tool.name === "shell_exec" ? <Terminal /> : <FileCode2 />}</span><div><header><strong>{tool.title}</strong><StatusBadge status={tool.risk} /></header><code>{tool.name}</code><p>{tool.detail}</p><span className={tool.approval && approvalMode ? "gated" : tool.approval ? "ungated" : "read-only"}>{tool.approval ? approvalMode ? <><ShieldCheck />Approval required</> : <><AlertTriangle />No approval gate</> : <><Check />No mutation</>}</span></div></article>)}</div></section></>;
}
