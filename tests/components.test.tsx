// @vitest-environment jsdom

import React, { useRef, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Field, InlineAlert, StatusBadge, handleTabListKeyDown } from "../src/components/ui";
import { useFocusTrap } from "../src/components/useFocusTrap";

afterEach(cleanup);

describe("shared accessible components", () => {
  it("exposes field labels, descriptions, and status text", () => {
    render(<><Field label="Workspace root" htmlFor="workspace" hint="Existing directory"><input id="workspace" aria-describedby="workspace-hint" /></Field><StatusBadge status="waiting_approval" /></>);
    const input = screen.getByRole("textbox", { name: "Workspace root" });
    expect(input.getAttribute("aria-describedby")).toBe("workspace-hint");
    expect(document.getElementById("workspace-hint")?.textContent).toBe("Existing directory");
    expect(screen.getByText("waiting approval")).toBeTruthy();
  });

  it("uses assertive and polite live semantics by alert tone", () => {
    const { rerender } = render(<InlineAlert title="Save failed">Try again.</InlineAlert>);
    expect(screen.getByRole("alert").textContent).toContain("Save failed");
    rerender(<InlineAlert tone="success" title="Saved">Ready.</InlineAlert>);
    expect(screen.getByRole("status").textContent).toContain("Saved");
  });

  it("supports roving arrow-key tabs", async () => {
    const user = userEvent.setup();
    render(<Tabs />);
    const first = screen.getByRole("tab", { name: "First" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Second" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Home}");
    expect(first.getAttribute("aria-selected")).toBe("true");
  });

  it("traps modal focus, closes with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    render(<ModalFixture />);
    const opener = screen.getByRole("button", { name: "Open panel" });
    await user.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close panel" })));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

function Tabs() {
  const [active, setActive] = useState("first");
  return <div role="tablist" aria-label="Example tabs" onKeyDown={handleTabListKeyDown}><button role="tab" tabIndex={active === "first" ? 0 : -1} aria-selected={active === "first"} onClick={() => setActive("first")}>First</button><button role="tab" tabIndex={active === "second" ? 0 : -1} aria-selected={active === "second"} onClick={() => setActive("second")}>Second</button></div>;
}

function ModalFixture() {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, modalRef, () => setOpen(false));
  return <><button onClick={() => setOpen(true)}>Open panel</button>{open && <div ref={modalRef} role="dialog" aria-label="Panel" tabIndex={-1}><button onClick={() => setOpen(false)}>Close panel</button><a href="#inside">Inside link</a></div>}</>;
}
