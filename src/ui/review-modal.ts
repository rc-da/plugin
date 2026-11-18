import type { App } from "obsidian";
import type { Preview } from "../core/preview";
import type { LocalChange, Path } from "../core/types";
import { t } from "../i18n";
import { PluginModal } from "./plugin-modal";

// Review modal (§10): local changes since the last sync, each with a checkbox.
// Unticked files are held back for this sync (both sides left untouched).

export class ReviewModal extends PluginModal {
  private preview: Preview | null = null;
  private readonly held = new Set<string>();

  constructor(
    app: App,
    private readonly load: () => Promise<Preview>,
    private readonly isBusy: () => boolean,
    private readonly onSync: (holdBack: ReadonlySet<Path>) => void,
  ) {
    super(app);
  }

  protected render(): void {
    this.setTitle(t("review.title"));
    this.contentEl.createEl("p", { cls: "vgs-muted", text: t("review.loading") });
    this.load().then(p => { this.preview = p; this.draw(); }, e => {
      this.contentEl.empty();
      this.contentEl.createEl("p", { cls: "vgs-error", text: e instanceof Error ? e.message : String(e) });
    });
  }

  private draw() {
    const { contentEl } = this;
    contentEl.empty();
    const p = this.preview;
    if (!p) return;
    if (p.firstSync) contentEl.createEl("p", { cls: "vgs-muted", text: t("review.firstSync") });
    if (p.changes.length === 0) {
      contentEl.createEl("p", { text: t("review.none") });
    } else {
      contentEl.createEl("p", { cls: "vgs-muted", text: t("review.hint") });
      const tools = contentEl.createDiv({ cls: "vgs-button-row vgs-left" });
      tools.createEl("button", { text: t("review.all") }).addEventListener("click", () => { this.held.clear(); this.draw(); });
      tools.createEl("button", { text: t("review.none.button") }).addEventListener("click", () => {
        for (const c of p.changes) this.held.add(c.path);
        this.draw();
      });
      const list = contentEl.createDiv({ cls: "vgs-review-list" });
      for (const c of p.changes) this.row(list, c);
    }
    const row = this.buttonRow(contentEl);
    row.createEl("button", { text: t("modal.cancel") }).addEventListener("click", () => this.close());
    const total = p.changes.length;
    const included = total - p.changes.filter(c => this.held.has(c.path)).length;
    const go = row.createEl("button", {
      cls: "mod-cta",
      text: this.held.size > 0 ? t("review.syncCount", { n: included, total }) : t("review.sync"),
    });
    go.addEventListener("click", () => {
      if (this.isBusy()) { go.setText(t("modal.busy")); return; }
      this.close();
      this.onSync(holdBackSet(p.changes, this.held));
    });
  }

  private row(list: HTMLElement, c: LocalChange) {
    const label = list.createEl("label", { cls: "vgs-review-row" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = !this.held.has(c.path);
    box.addEventListener("change", () => {
      if (box.checked) this.held.delete(c.path); else this.held.add(c.path);
      this.draw();
    });
    label.createSpan({ cls: `vgs-badge vgs-badge-${c.kind}`, text: t(`review.kind.${c.kind}` as const) });
    label.createSpan({ cls: "vgs-review-path", text: c.kind === "renamed" ? `${c.oldPath} → ${c.path}` : c.path });
  }
}

/** Held paths, with both ends of a held rename (so neither half is synced alone). */
export function holdBackSet(changes: readonly LocalChange[], held: ReadonlySet<string>): ReadonlySet<Path> {
  const out = new Set<Path>();
  for (const c of changes) {
    if (!held.has(c.path)) continue;
    out.add(c.path);
    if (c.kind === "renamed") out.add(c.oldPath);
  }
  return out;
}
