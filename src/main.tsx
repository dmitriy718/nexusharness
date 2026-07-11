import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  Boxes,
  Cpu,
  FolderTree,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  Settings,
  ShieldAlert,
  Trash2
} from "lucide-react";
import "./styles.css";

type Runtime = { id: string; name: string; kind: string; endpoint?: string; binaryPath?: string; modelPath?: string; timeoutMs: number };
type Model = { id: string; runtimeId: string; name: string; contextWindow?: number; supportsTools: boolean; quantization?: string };
type McpServer = { id: string; name: string; endpoint: string; transport: "http" | "stdio"; enabled: boolean; status: string; tools: { name: string; enabled: boolean; description?: string }[]; lastError?: string };
type MemoryEntry = { id: string; kind: "retrospective" | "snippet" | "context"; taskType: string; title: string; content: string; pinned: boolean; source?: string };
type SettingsShape = {
  workspaceRoot: string;
  layout: "chat" | "ide" | "agents" | null;
  maxIterations: number;
  maxParallelExecutors: number;
  criticThreshold: number;
  approvalMode: boolean;
  shellPath: string;
  testCommand: string;
  lintCommand: string;
  mcpAutoDiscovery: boolean;
  mcpPortStart: number;
  mcpPortEnd: number;
  memoryTokenBudget: number;
  agentModels: Record<string, string | undefined>;
};
type Store = {
  settings: SettingsShape;
  runtimes: Runtime[];
  mcpServers: McpServer[];
  memory: MemoryEntry[];
  audit: any[];
  approvals: any[];
  runs: any[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(typeof error.error === "string" ? error.error : JSON.stringify(error.error));
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

function App() {
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState("tasks");
  const [models, setModels] = useState<Model[]>([]);
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});

  const refresh = async () => {
    const next = await api<Store>("/api/state?compact=1");
    setStore(next);
    return next;
  };

  const refreshModels = async (runtimes = store?.runtimes ?? [], fresh = false) => {
    const results = await Promise.all(runtimes.map(async (runtime) => {
      try {
        return { runtimeId: runtime.id, models: await api<Model[]>(`/api/runtimes/${runtime.id}/models${fresh ? "?fresh=1" : ""}`) };
      } catch (err: any) {
        return { runtimeId: runtime.id, models: [], error: err.message };
      }
    }));
    setModels((previous) => {
      const configuredRuntimeIds = new Set(runtimes.map((runtime) => runtime.id));
      const successfulRuntimeIds = new Set(results.filter((result) => !result.error).map((result) => result.runtimeId));
      return [
        ...previous.filter((model) => configuredRuntimeIds.has(model.runtimeId) && !successfulRuntimeIds.has(model.runtimeId)),
        ...results.flatMap((result) => result.models)
      ];
    });
    setModelErrors(Object.fromEntries(results.filter((result) => result.error).map((result) => [result.runtimeId, result.error])));
  };

  useEffect(() => {
    let refreshing = false;
    refresh().then((next) => refreshModels(next.runtimes)).catch((err) => setError(err.message));
    const timer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try { await refresh(); } catch (err: any) { setError(err.message); } finally { refreshing = false; }
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const saveSettings = async (settings: SettingsShape) => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
    await refresh();
  };

  if (!store) return <div className="boot">NexusHarness API not reachable. Start with npm run dev.</div>;
  if (!store.settings.layout) return <FirstLaunch store={store} saveSettings={saveSettings} setActive={setActive} />;

  return (
    <div className={`app layout-${store.settings.layout}`}>
      <aside className="nav">
        <div className="brand"><GitBranch size={20} /> NexusHarness</div>
        <NavButton id="tasks" active={active} setActive={setActive} icon={<MessageSquare size={17} />} label="Tasks" />
        <NavButton id="models" active={active} setActive={setActive} icon={<Cpu size={17} />} label="Models" />
        <NavButton id="mcp" active={active} setActive={setActive} icon={<Boxes size={17} />} label="MCP" />
        <NavButton id="workspace" active={active} setActive={setActive} icon={<FolderTree size={17} />} label="Workspace" />
        <NavButton id="memory" active={active} setActive={setActive} icon={<Bot size={17} />} label="Memory" />
        <NavButton id="settings" active={active} setActive={setActive} icon={<Settings size={17} />} label="Settings" />
      </aside>
      <main>
        {error && <div className="error" onClick={() => setError("")}>{error}</div>}
        {active === "tasks" && <Tasks store={store} refresh={refresh} setError={setError} />}
        {active === "models" && <Models store={store} models={models} modelErrors={modelErrors} refresh={refresh} refreshModels={refreshModels} saveSettings={saveSettings} setError={setError} />}
        {active === "mcp" && <Mcp store={store} refresh={refresh} setError={setError} />}
        {active === "workspace" && <Workspace setError={setError} />}
        {active === "memory" && <MemoryPanel store={store} refresh={refresh} setError={setError} />}
        {active === "settings" && <SettingsPanel store={store} saveSettings={saveSettings} setError={setError} />}
      </main>
      <RunRail store={store} refresh={refresh} setError={setError} />
    </div>
  );
}

function NavButton({ id, active, setActive, icon, label }: any) {
  return <button className={active === id ? "navbtn active" : "navbtn"} onClick={() => setActive(id)}>{icon}{label}</button>;
}

function FirstLaunch({ store, saveSettings, setActive }: any) {
  const [error, setError] = useState("");
  const choose = async (layout: "chat" | "ide" | "agents") => {
    try {
      await saveSettings({ ...store.settings, layout });
      setActive("models");
    } catch (err: any) { setError(err.message); }
  };
  return (
    <div className="first">
      <h1>NexusHarness</h1>
      <p>Select the operator layout. The choice is stored locally and can be changed later.</p>
      {error && <div className="error">{error}</div>}
      <div className="layoutChoices">
        <button onClick={() => choose("chat")}><MessageSquare /> Chat-first</button>
        <button onClick={() => choose("ide")}><LayoutDashboard /> IDE-style</button>
        <button onClick={() => choose("agents")}><GitBranch /> Agent Control</button>
      </div>
    </div>
  );
}

function Tasks({ store, refresh, setError }: any) {
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await api("/api/tasks", { method: "POST", body: JSON.stringify({ task }) });
      setTask("");
      await refresh();
    } catch (err: any) { setError(err.message); } finally { setStarting(false); }
  };
  return (
    <section>
      <Header title="Task Execution" detail="Planner -> Executor -> Critic -> Test -> Retrospective" />
      <div className="composer">
        <textarea value={task} onChange={(event) => setTask(event.target.value)} placeholder="Describe the coding task for the local agents..." />
        <button className="primary" onClick={start} disabled={!task.trim() || starting}><Play size={16} /> {starting ? "Starting..." : "Run"}</button>
      </div>
      <AgentGraph runs={store.runs} refresh={refresh} setError={setError} />
    </section>
  );
}

function Models({ store, models, modelErrors, refresh, refreshModels, saveSettings, setError }: any) {
  const [form, setForm] = useState({ name: "", kind: "ollama", endpoint: "http://127.0.0.1:11434", binaryPath: "", modelPath: "", timeoutMs: 60000 });
  const add = async () => {
    try {
      await api("/api/runtimes", { method: "POST", body: JSON.stringify(form) });
      const next = await refresh();
      await refreshModels(next.runtimes, true);
    } catch (err: any) { setError(err.message); }
  };
  const assign = async (role: string, modelId: string) => {
    try { await saveSettings({ ...store.settings, agentModels: { ...store.settings.agentModels, [role]: modelId || undefined } }); }
    catch (err: any) { setError(err.message); }
  };
  return (
    <section>
      <Header title="Models" detail="Real runtime discovery for Ollama, LM Studio, llama.cpp server, and llama.cpp CLI." />
      <div className="buttonRow"><button onClick={() => refreshModels(store.runtimes, true)}><RefreshCw size={15} /> Refresh model inventory</button></div>
      <div className="grid two">
        <div className="panel">
          <h3>Add Runtime</h3>
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="ollama">Ollama REST</option>
            <option value="lmstudio">LM Studio OpenAI API</option>
            <option value="llamacpp-server">llama.cpp server</option>
            <option value="llamacpp-cli">llama.cpp CLI</option>
          </select>
          <input placeholder="Endpoint URL" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
          <input placeholder="llama.cpp binary path" value={form.binaryPath} onChange={(e) => setForm({ ...form, binaryPath: e.target.value })} />
          <input placeholder="GGUF model path" value={form.modelPath} onChange={(e) => setForm({ ...form, modelPath: e.target.value })} />
          <button className="primary" onClick={add}><Save size={16} /> Add</button>
        </div>
        <div className="panel">
          <h3>Agent Assignments</h3>
          {["planner", "executor", "critic"].map((role) => (
            <label className="row" key={role}>{role}
              <select value={store.settings.agentModels[role] ?? ""} onChange={(e) => assign(role, e.target.value)}>
                <option value="">Unassigned</option>
                {models.map((model: Model) => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>
      <div className="cards">
        {store.runtimes.map((runtime: Runtime) => <RuntimeCard key={runtime.id} runtime={runtime} models={models.filter((model: Model) => model.runtimeId === runtime.id)} modelError={modelErrors[runtime.id]} refresh={refresh} refreshModels={refreshModels} setError={setError} />)}
      </div>
    </section>
  );
}

function RuntimeCard({ runtime, models, modelError, refresh, refreshModels, setError }: any) {
  return (
    <div className="card">
      <div className="cardHead"><Cpu size={16} /><strong>{runtime.name}</strong><span>{runtime.kind}</span></div>
      <code>{runtime.endpoint || runtime.binaryPath}</code>
      {modelError && <p className="warn">{modelError}</p>}
      {models.map((model: Model) => <div className="model" key={model.id}><b>{model.name}</b><span>ctx {model.contextWindow ?? "unknown"}</span><span>{model.supportsTools ? "tools" : "text"}</span><span>{model.quantization ?? ""}</span></div>)}
      <button onClick={async () => {
        try {
          await api(`/api/runtimes/${runtime.id}`, { method: "DELETE" });
          const next = await refresh();
          await refreshModels(next.runtimes);
        } catch (err: any) {
          setError(err.message);
        }
      }}><Trash2 size={15} /> Remove</button>
    </div>
  );
}

function Mcp({ store, refresh, setError }: any) {
  const [form, setForm] = useState({ name: "", endpoint: "http://127.0.0.1:3001", transport: "http", command: "", args: "", enabled: true });
  const parseArgs = () => {
    const trimmed = form.args.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) return JSON.parse(trimmed);
    return trimmed.split(/\s+/);
  };
  const updateServer = async (server: McpServer) => {
    try {
      await api(`/api/mcp/${server.id}`, { method: "PUT", body: JSON.stringify(server) });
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };
  const add = async () => {
    try {
      await api("/api/mcp", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          endpoint: form.transport === "stdio" ? "stdio" : form.endpoint,
          args: parseArgs()
        })
      });
      await refresh();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <section>
      <Header title="MCP Servers" detail="Discovery and tool schema loading use live JSON-RPC calls." />
      <div className="toolbar">
        <button onClick={async () => {
          try {
            await api("/api/mcp/discover", { method: "POST" });
            await refresh();
          } catch (err: any) {
            setError(err.message);
          }
        }}><RefreshCw size={15} /> Scan localhost</button>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })}>
          <option value="http">HTTP</option>
          <option value="stdio">stdio</option>
        </select>
        {form.transport === "http" ? (
          <input placeholder="Endpoint" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
        ) : (
          <>
            <input placeholder="Command" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
            <input placeholder="Args" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
          </>
        )}
        <button className="primary" onClick={add}>Add</button>
      </div>
      <div className="cards">
        {store.mcpServers.map((server: McpServer) => (
          <div className="card" key={server.id}>
            <div className="cardHead"><Boxes size={16} /><strong>{server.name}</strong><Status value={server.status} /></div>
            <code>{server.endpoint}</code>
            {server.lastError && <p className="warn">{server.lastError}</p>}
            <div className="buttonRow">
              <button onClick={async () => {
                try {
                  await api(`/api/mcp/${server.id}/refresh`, { method: "POST" });
                  await refresh();
                } catch (err: any) {
                  setError(err.message);
                }
              }}><RefreshCw size={15} /> Refresh</button>
              <button onClick={async () => {
                try {
                  await api(`/api/mcp/${server.id}`, { method: "DELETE" });
                  await refresh();
                } catch (err: any) {
                  setError(err.message);
                }
              }}><Trash2 size={15} /> Remove</button>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={(event) => updateServer({ ...server, enabled: event.target.checked })}
              />
              Server enabled
            </label>
            {server.tools.map((tool, index) => <label className="check" key={`${tool.name}-${index}`}>
              <input
                type="checkbox"
                checked={tool.enabled}
                onChange={(event) => updateServer({
                  ...server,
                  tools: server.tools.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, enabled: event.target.checked } : candidate)
                })}
              />
              {tool.name}
            </label>)}
          </div>
        ))}
      </div>
    </section>
  );
}

function Workspace({ setError }: { setError: (error: string) => void }) {
  const [tree, setTree] = useState<any[]>([]);
  useEffect(() => { api<any[]>("/api/workspace/tree").then(setTree).catch((err) => setError(err.message)); }, [setError]);
  return <section><Header title="Workspace" detail="Filesystem access is mediated by the local API and constrained to the configured root." /><Tree nodes={tree} /></section>;
}

function Tree({ nodes }: { nodes: any[] }) {
  return <div className="tree">{nodes.map((node) => <div key={node.path}><span>{node.type === "directory" ? "▸" : "·"} {node.name}</span>{node.children?.length ? <Tree nodes={node.children} /> : null}</div>)}</div>;
}

function MemoryPanel({ store, refresh, setError }: any) {
  const [entry, setEntry] = useState({ kind: "context", taskType: "", title: "", content: "", pinned: false, source: "operator" });
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const add = async () => {
    try {
      await api("/api/memory", { method: "POST", body: JSON.stringify(entry) });
      await refresh();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <section>
      <Header title="Memory" detail="Retrospectives and operator context are persisted locally." />
      <div className="grid two">
        <div className="panel">
          <input placeholder="Task type" value={entry.taskType} onChange={(e) => setEntry({ ...entry, taskType: e.target.value })} />
          <input placeholder="Title" value={entry.title} onChange={(e) => setEntry({ ...entry, title: e.target.value })} />
          <textarea placeholder="Content" value={entry.content} onChange={(e) => setEntry({ ...entry, content: e.target.value })} />
          <button className="primary" onClick={add}>Add Memory</button>
        </div>
        <div className="panel scroll">
          {store.memory.map((item: MemoryEntry) => <article className="memory" key={item.id}>
            {editing?.id === item.id ? (
              <MemoryEditor
                entry={editing}
                setEntry={setEditing}
                save={async () => {
                  try {
                    await api(`/api/memory/${item.id}`, { method: "PUT", body: JSON.stringify(editing) });
                    setEditing(null);
                    await refresh();
                  } catch (err: any) {
                    setError(err.message);
                  }
                }}
              />
            ) : (
              <>
                <b>{item.pinned ? "[Pinned] " : ""}{item.title}</b><span>{item.kind} · {item.taskType}</span><p>{item.content}</p>
                <div className="buttonRow">
                  <button onClick={() => setEditing(item)}>Edit</button>
                  <button onClick={async () => {
                    try {
                      await api(`/api/memory/${item.id}`, { method: "PUT", body: JSON.stringify({ ...item, pinned: !item.pinned }) });
                      await refresh();
                    } catch (err: any) {
                      setError(err.message);
                    }
                  }}>{item.pinned ? "Unpin" : "Pin"}</button>
                  <button onClick={async () => {
                    try {
                      await api(`/api/memory/${item.id}`, { method: "DELETE" });
                      await refresh();
                    } catch (err: any) {
                      setError(err.message);
                    }
                  }}><Trash2 size={15} /> Delete</button>
                </div>
              </>
            )}
          </article>)}
        </div>
      </div>
    </section>
  );
}

function MemoryEditor({ entry, setEntry, save }: { entry: MemoryEntry; setEntry: (entry: MemoryEntry | null) => void; save: () => Promise<void> }) {
  return (
    <div className="editor">
      <select value={entry.kind} onChange={(event) => setEntry({ ...entry, kind: event.target.value as MemoryEntry["kind"] })}>
        <option value="context">Context</option>
        <option value="snippet">Snippet</option>
        <option value="retrospective">Retrospective</option>
      </select>
      <input value={entry.taskType} onChange={(event) => setEntry({ ...entry, taskType: event.target.value })} />
      <input value={entry.title} onChange={(event) => setEntry({ ...entry, title: event.target.value })} />
      <textarea value={entry.content} onChange={(event) => setEntry({ ...entry, content: event.target.value })} />
      <label className="check"><input type="checkbox" checked={entry.pinned} onChange={(event) => setEntry({ ...entry, pinned: event.target.checked })} />Pinned</label>
      <div className="buttonRow"><button className="primary" onClick={save}>Save</button><button onClick={() => setEntry(null)}>Cancel</button></div>
    </div>
  );
}

function SettingsPanel({ store, saveSettings, setError }: any) {
  const [settings, setSettings] = useState(store.settings);
  return (
    <section>
      <Header title="Settings" detail="Local-only configuration. No telemetry, cloud auth, or hosted model dependency." />
      <div className="panel settingsGrid">
        <input value={settings.workspaceRoot} onChange={(e) => setSettings({ ...settings, workspaceRoot: e.target.value })} />
        <select value={settings.layout ?? "chat"} onChange={(e) => setSettings({ ...settings, layout: e.target.value })}>
          <option value="chat">Chat-first</option>
          <option value="ide">IDE-style</option>
          <option value="agents">Agent Control</option>
        </select>
        <NumberField label="Max iterations" value={settings.maxIterations} set={(value: number) => setSettings({ ...settings, maxIterations: value })} />
        <NumberField label="Parallel executors" value={settings.maxParallelExecutors} set={(value: number) => setSettings({ ...settings, maxParallelExecutors: value })} />
        <NumberField label="Critic threshold" value={settings.criticThreshold} set={(value: number) => setSettings({ ...settings, criticThreshold: value })} />
        <label className="check"><input type="checkbox" checked={settings.approvalMode} onChange={(e) => setSettings({ ...settings, approvalMode: e.target.checked })} />Approval mode</label>
        <label className="check"><input type="checkbox" checked={settings.mcpAutoDiscovery} onChange={(e) => setSettings({ ...settings, mcpAutoDiscovery: e.target.checked })} />MCP discovery</label>
        <NumberField label="MCP port start" value={settings.mcpPortStart} set={(value: number) => setSettings({ ...settings, mcpPortStart: value })} />
        <NumberField label="MCP port end" value={settings.mcpPortEnd} set={(value: number) => setSettings({ ...settings, mcpPortEnd: value })} />
        <NumberField label="Memory token budget" value={settings.memoryTokenBudget} set={(value: number) => setSettings({ ...settings, memoryTokenBudget: value })} />
        <input value={settings.shellPath} onChange={(e) => setSettings({ ...settings, shellPath: e.target.value })} />
        <input placeholder="Test command" value={settings.testCommand} onChange={(e) => setSettings({ ...settings, testCommand: e.target.value })} />
        <input placeholder="Lint command" value={settings.lintCommand} onChange={(e) => setSettings({ ...settings, lintCommand: e.target.value })} />
        <button className="primary" onClick={async () => {
          try { await saveSettings(settings); } catch (err: any) { setError(err.message); }
        }}><Save size={16} /> Save</button>
      </div>
    </section>
  );
}

function NumberField({ label, value, set }: any) {
  return <label className="row">{label}<input type="number" value={value} onChange={(e) => set(Number(e.target.value))} /></label>;
}

function RunRail({ store, refresh, setError }: any) {
  const decide = async (id: string, decision: "approved" | "rejected") => {
    try { await api(`/api/approvals/${id}/${decision}`, { method: "POST" }); await refresh(); }
    catch (err: any) { setError(err.message); }
  };
  return (
    <aside className="rail">
      <h3>Approvals</h3>
      {store.approvals.filter((a: any) => a.decision === "pending").map((approval: any) => (
        <div className="approval" key={approval.id}>
          <ShieldAlert size={15} /><b>{approval.action}</b><code>{JSON.stringify(approval.payload)}</code>
          <button onClick={() => decide(approval.id, "approved")}>Approve</button>
          <button onClick={() => decide(approval.id, "rejected")}>Reject</button>
        </div>
      ))}
      <h3>Run Log</h3>
      {store.audit.slice(0, 80).map((event: any) => <details className="event" key={event.id}>
        <summary><span>{event.actor}</span><b>{event.action}</b><small>{event.message}</small></summary>
        {event.details && <pre>{typeof event.details === "string" ? event.details : JSON.stringify(event.details, null, 2)}</pre>}
      </details>)}
      {store.runs.filter((r: any) => r.status === "waiting_approval").map((run: any) => <button key={run.id} onClick={async () => { try { await api(`/api/tasks/${run.id}/resume`, { method: "POST" }); await refresh(); } catch (err: any) { setError(err.message); } }}><RefreshCw size={15} /> Resume {run.id.slice(0, 6)}</button>)}
    </aside>
  );
}

function AgentGraph({ runs, refresh, setError }: { runs: any[]; refresh: () => Promise<Store>; setError: (error: string) => void }) {
  const latest = runs[0];
  const nodes = useMemo(() => ["plan", "execute", "critic", "test", "retrospective", "done"], []);
  return (
    <div className="graph">
      {nodes.map((node) => <div className={latest?.phase === node ? "agent active" : "agent"} key={node}><Bot size={18} /><b>{node}</b><span>{latest?.status ?? "idle"}</span></div>)}
      <div className="panel log">
        {runs.slice(0, 8).map((run) => <article key={run.id}>
          <b>{run.task}</b>
          <span>{run.status} · {run.phase} · iteration {run.iteration}/{run.maxIterations}{run.criticScore ? ` · score ${run.criticScore}/10` : ""}</span>
          {run.status === "running" && <button onClick={async () => {
            try { await api(`/api/tasks/${run.id}/cancel`, { method: "POST" }); await refresh(); }
            catch (err: any) { setError(err.message); }
          }}>Cancel run</button>}
          {(run.status === "failed" || run.status === "canceled") && <button onClick={async () => {
            try { await api(`/api/tasks/${run.id}/resume`, { method: "POST" }); await refresh(); }
            catch (err: any) { setError(err.message); }
          }}>Resume from checkpoint</button>}
          {run.error && <p className="warn">{run.error}</p>}
        </article>)}
      </div>
    </div>
  );
}

function Header({ title, detail }: { title: string; detail: string }) {
  return <div className="header"><h2>{title}</h2><p>{detail}</p></div>;
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value}</span>;
}

createRoot(document.getElementById("root")!).render(<App />);
