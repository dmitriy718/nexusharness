import React, { useState } from "react";
import { Boxes, Check, Network, Plus, RefreshCw, Search, Terminal, Trash2, Wrench } from "lucide-react";
import { api, errorMessage } from "../../api/client";
import type { McpServer } from "../../api/types";
import { useHarness } from "../../app/StoreProvider";
import { EmptyState, Field, InlineAlert, PageHeader, StatusBadge } from "../../components/ui";

export function ToolsPage() {
  const { store, refresh, notify } = useHarness();
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [localError, setLocalError] = useState("");
  const [form, setForm] = useState({ name: "", endpoint: "http://127.0.0.1:3001", transport: "http", command: "", args: "", enabled: true });
  if (!store) return null;

  const add = async () => {
    setBusy("add");
    setLocalError("");
    try {
      const args = form.args.trim() ? (form.args.trim().startsWith("[") ? JSON.parse(form.args) : form.args.trim().split(/\s+/)) : [];
      await api("/api/mcp", { method: "POST", body: JSON.stringify({ ...form, endpoint: form.transport === "stdio" ? "stdio" : form.endpoint, args }) });
      await refresh();
      setFormOpen(false);
      setForm((current) => ({ ...current, name: "", command: "", args: "" }));
      notify("MCP server added.");
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const discover = async () => {
    setBusy("discover");
    setLocalError("");
    try {
      const found = await api<McpServer[]>("/api/mcp/discover", { method: "POST" });
      await refresh();
      notify(found.length + " new MCP server" + (found.length === 1 ? "" : "s") + " discovered.");
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  const update = async (server: McpServer) => {
    try {
      await api("/api/mcp/" + server.id, { method: "PUT", body: JSON.stringify(server) });
      await refresh();
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const remove = async (server: McpServer) => {
    if (!window.confirm("Remove MCP server " + server.name + "?")) return;
    try {
      await api("/api/mcp/" + server.id, { method: "DELETE" });
      await refresh();
      notify("MCP server removed.", "info");
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const servers = store.mcpServers.filter((server) => !query || [server.name, server.endpoint, ...server.tools.map((tool) => tool.name)].join(" ").toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page">
      <PageHeader
        eyebrow="Capability layer"
        title="Tools & MCP"
        detail="Connect inspected capabilities to Executor agents while preserving explicit local policy."
        actions={<><button className="button secondary" disabled={Boolean(busy)} onClick={() => void discover()}><RefreshCw className={busy === "discover" ? "spin" : ""} />{busy === "discover" ? "Scanning…" : "Scan localhost"}</button><button className="button primary" onClick={() => setFormOpen((value) => !value)}><Plus />Add server</button></>}
      />
      {localError && <InlineAlert title="Tool action failed">{localError}</InlineAlert>}

      {formOpen && <section className="section-block connection-form">
        <div className="section-heading"><div><p className="eyebrow">New MCP connection</p><h2>Server details</h2></div></div>
        <div className="form-grid">
          <Field label="Display name" htmlFor="mcp-name"><input id="mcp-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Local filesystem tools" /></Field>
          <Field label="Transport" htmlFor="mcp-transport"><select id="mcp-transport" value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value })}><option value="http">Streamable HTTP</option><option value="stdio">stdio process</option></select></Field>
          {form.transport === "http" ? <Field label="Endpoint" htmlFor="mcp-endpoint"><input id="mcp-endpoint" value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} /></Field> : <>
            <Field label="Command" htmlFor="mcp-command"><input id="mcp-command" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder="npx" /></Field>
            <Field label="Arguments" htmlFor="mcp-args" hint="Whitespace-separated values or a JSON string array."><input id="mcp-args" value={form.args} onChange={(event) => setForm({ ...form, args: event.target.value })} aria-describedby="mcp-args-hint" placeholder="-y @modelcontextprotocol/server-filesystem ." /></Field>
          </>}
        </div>
        <div className="form-actions"><button className="button quiet" onClick={() => setFormOpen(false)}>Cancel</button><button className="button primary" disabled={!form.name.trim() || busy === "add"} onClick={() => void add()}><Network />{busy === "add" ? "Connecting…" : "Connect and inspect"}</button></div>
      </section>}

      <div className="tool-stats metric-grid">
        <article className="metric-card metric-violet"><span className="metric-icon"><Boxes /></span><div><p>Servers</p><strong>{store.mcpServers.length}</strong><small>configured endpoints</small></div></article>
        <article className="metric-card metric-cyan"><span className="metric-icon"><Wrench /></span><div><p>Tools</p><strong>{store.mcpServers.flatMap((server) => server.tools).length}</strong><small>discovered capabilities</small></div></article>
        <article className="metric-card metric-green"><span className="metric-icon"><Check /></span><div><p>Enabled</p><strong>{store.mcpServers.filter((server) => server.enabled).flatMap((server) => server.tools.filter((tool) => tool.enabled)).length}</strong><small>available to executors</small></div></article>
      </div>

      <section className="section-block">
        <div className="section-heading responsive-heading"><div><p className="eyebrow">Connections</p><h2>{servers.length} visible</h2></div><label className="search-control"><Search /><span className="sr-only">Search servers and tools</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tools" /></label></div>
        {servers.length ? <div className="server-list">{servers.map((server) => <article className="server-card" key={server.id}>
          <header><span className="metric-icon metric-blue">{server.transport === "stdio" ? <Terminal /> : <Network />}</span><div><h3>{server.name}</h3><code>{server.transport === "stdio" ? server.command || "stdio" : server.endpoint}</code></div><StatusBadge status={server.status} /><label className="switch-control"><span className="sr-only">Enable {server.name}</span><input type="checkbox" checked={server.enabled} onChange={(event) => void update({ ...server, enabled: event.target.checked })} /><span /></label></header>
          {server.lastError && <InlineAlert title="Server error">{server.lastError}</InlineAlert>}
          <div className="tool-list">{server.tools.map((tool, index) => <label key={tool.name + index} className="tool-row"><span className="tool-symbol"><Wrench /></span><span><strong>{tool.name}</strong><small>{tool.description || "No description provided by this server."}</small></span><input type="checkbox" checked={tool.enabled} onChange={(event) => void update({ ...server, tools: server.tools.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, enabled: event.target.checked } : candidate) })} /></label>)}</div>
          <footer><span>{server.tools.filter((tool) => tool.enabled).length}/{server.tools.length} enabled</span><button className="button danger-quiet" onClick={() => void remove(server)}><Trash2 />Remove</button></footer>
        </article>)}</div> : <EmptyState icon={<Boxes />} title={store.mcpServers.length ? "No matching tools" : "No MCP servers connected"} detail={store.mcpServers.length ? "Try a different search." : "Connect a server manually or scan the configured localhost port range."} />}
      </section>
    </div>
  );
}
