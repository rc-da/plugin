import { setIcon, setTooltip } from "obsidian";
import type { StatusView } from "./status-model";

// Thin DOM renderer for the status bar item (§10). All decisions live in status-model.ts.
// Obsidian mobile has no status bar; there the ribbon icon and notices carry the state.

export class StatusBar {
  private readonly iconEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private last: StatusView | null = null;

  constructor(readonly el: HTMLElement) {
    el.addClass("vgs-status", "mod-clickable");
    this.iconEl = el.createSpan({ cls: "vgs-status-icon" });
    this.textEl = el.createSpan({ cls: "vgs-status-text" });
  }

  render(v: StatusView) {
    const l = this.last;
    if (!l || l.icon !== v.icon) setIcon(this.iconEl, v.icon);
    if (!l || l.text !== v.text) this.textEl.setText(v.text);
    if (!l || l.tooltip !== v.tooltip) setTooltip(this.el, v.tooltip, { placement: "top" });
    for (const tone of ["ok", "busy", "warn", "error", "muted"] as const) this.el.toggleClass(`vgs-tone-${tone}`, v.tone === tone);
    this.el.toggleClass("vgs-spinning", v.spinning);
    this.last = v;
  }
}
