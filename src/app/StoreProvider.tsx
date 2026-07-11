import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api/client";
import type { BuildHealth, SettingsShape, Store } from "../api/types";

type Notice = {
  id: number;
  tone: "success" | "danger" | "info";
  message: string;
};

type StoreContextShape = {
  store: Store | null;
  health: BuildHealth | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
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
  const [error, setError] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const inFlight = useRef(false);
  const latestStore = useRef<Store | null>(null);

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
    setRefreshing(true);
    try {
      const next = await api<Store>("/api/state?compact=1");
      setStore(next);
      latestStore.current = next;
      setError("");
      return next;
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      throw caught;
    } finally {
      inFlight.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

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
    }, 5000);
    const healthTimer = window.setInterval(() => void refreshHealth(), 30000);
    return () => {
      window.clearInterval(stateTimer);
      window.clearInterval(healthTimer);
    };
  }, [refresh, refreshHealth]);

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
    error,
    notices,
    refresh,
    saveSettings,
    notify,
    clearError: () => setError(""),
    dismissNotice: (id) => setNotices((current) => current.filter((item) => item.id !== id))
  }), [error, health, loading, notices, notify, refresh, refreshing, saveSettings, store]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useHarness() {
  const context = useContext(StoreContext);
  if (!context) throw new Error("useHarness must be used inside StoreProvider.");
  return context;
}
