import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { BuildHealth, SettingsShape, Store } from "../api/types";
import { stabilizeStore } from "../features/feedback/feedbackModel";

type Notice = {
  id: number;
  tone: "success" | "danger" | "info" | "warning";
  message: string;
};

export type ConnectionState = "booting" | "online" | "reconnecting" | "stale" | "offline";

type StoreContextShape = {
  store: Store | null;
  health: BuildHealth | null;
  loading: boolean;
  refreshing: boolean;
  connectionState: ConnectionState;
  lastSyncedAt: string | null;
  error: string;
  failure: unknown;
  notices: Notice[];
  refresh: () => Promise<Store>;
  saveSettings: (settings: SettingsShape) => Promise<void>;
  notify: (message: string, tone?: Notice["tone"]) => void;
  clearError: () => void;
  dismissNotice: (id: number) => void;
};

const StoreContext = createContext<StoreContextShape | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
  const [health, setHealth] = useState<BuildHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("booting");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<unknown>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const inFlight = useRef(false);
  const latestStore = useRef<Store | null>(null);
  const connectionRef = useRef<ConnectionState>("booting");
  const lastSyncedRef = useRef<string | null>(null);

  const updateConnection = useCallback((state: ConnectionState) => {
    connectionRef.current = state;
    setConnectionState(state);
  }, []);

  const notify = useCallback((message: string, tone: Notice["tone"] = "success") => {
    const id = ++noticeId.current;
    setNotices((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      const current = latestStore.current;
      if (current) return current;
    }
    inFlight.current = true;
    if (latestStore.current && ["offline", "stale"].includes(connectionRef.current)) updateConnection("reconnecting");
    const indicator = window.setTimeout(() => setRefreshing(true), 250);
    try {
      const next = await api<Store>("/api/state?compact=1");
      const syncedAt = new Date().toISOString();
      const stable = stabilizeStore(latestStore.current, next);
      setStore(stable);
      latestStore.current = stable;
      lastSyncedRef.current = syncedAt;
      setLastSyncedAt(syncedAt);
      setError("");
      setFailure(null);
      updateConnection("online");
      return stable;
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setFailure(caught);
      updateConnection("offline");
      throw caught;
    } finally {
      window.clearTimeout(indicator);
      inFlight.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, [updateConnection]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api<BuildHealth>("/api/health"));
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void Promise.allSettled([refresh(), refreshHealth()]);
    const stateTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch(() => undefined);
    }, 10000);
    const healthTimer = window.setInterval(() => void refreshHealth(), 30000);
    const freshnessTimer = window.setInterval(() => {
      const syncedAt = lastSyncedRef.current;
      if (syncedAt && connectionRef.current === "online" && Date.now() - new Date(syncedAt).getTime() > 20000) updateConnection("stale");
    }, 5000);
    const online = () => void refresh().catch(() => undefined);
    const offline = () => updateConnection("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.clearInterval(stateTimer);
      window.clearInterval(healthTimer);
      window.clearInterval(freshnessTimer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [refresh, refreshHealth, updateConnection]);

  const saveSettings = useCallback(async (settings: SettingsShape) => {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
    await refresh();
    notify("Settings saved.");
  }, [notify, refresh]);

  const value = useMemo<StoreContextShape>(() => ({
    store,
    health,
    loading,
    refreshing,
    connectionState,
    lastSyncedAt,
    error,
    failure,
    notices,
    refresh,
    saveSettings,
    notify,
    clearError: () => { setError(""); setFailure(null); },
    dismissNotice: (id) => setNotices((current) => current.filter((item) => item.id !== id))
  }), [connectionState, error, failure, health, lastSyncedAt, loading, notices, notify, refresh, refreshing, saveSettings, store]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useHarness() {
  const context = useContext(StoreContext);
  if (!context) throw new Error("useHarness must be used inside StoreProvider.");
  return context;
}
