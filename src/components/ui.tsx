import React from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, LoaderCircle } from "lucide-react";
import type { RunStatus } from "../api/types";

export function PageHeader({
  eyebrow,
  title,
  detail,
  actions
}: {
  eyebrow?: string;
  title: string;
  detail: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="page-detail">{detail}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replaceAll(" ", "_");
  return <span className={"status-badge status-" + normalized}><span aria-hidden="true" />{status.replaceAll("_", " ")}</span>;
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusBadge status={status} />;
}

export function EmptyState({
  icon,
  title,
  detail,
  action
}: {
  icon?: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">{icon ?? <ArrowUpRight />}</div>
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function InlineAlert({
  tone = "danger",
  title,
  children
}: {
  tone?: "danger" | "warning" | "success" | "info";
  title: string;
  children?: React.ReactNode;
}) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? LoaderCircle : AlertTriangle;
  return (
    <div className={"inline-alert alert-" + tone} role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div><strong>{title}</strong>{children && <div>{children}</div>}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {hint && <p className="field-hint" id={htmlFor + "-hint"}>{hint}</p>}
      {children}
    </div>
  );
}

export function handleTabListKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']:not(:disabled)")];
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

export function formatDate(value?: string) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function formatDuration(start?: string, end?: string) {
  if (!start || !end) return "—";
  const milliseconds = Math.max(0, Date.parse(end) - Date.parse(start));
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds % 60) + "s";
}

export function shortId(value: string) {
  return value.slice(0, 8);
}
