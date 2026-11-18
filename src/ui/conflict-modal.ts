import type { App } from "obsidian";
import type { ConflictChoice, ResolveOutcome } from "../core/conflicts";
import type { ConflictRecord } from "../core/types";
import { t } from "../i18n";
import { PluginModal } from "./plugin-modal";

// Conflict modal (§5.5): the recorded conflicts with keep mine / keep theirs /
// keep both / compare / edit manually, plus bulk actions. Refusals (a file was
// edited after the conflict) are shown inline next to the file.

export interface ConflictModalHost {
  list(): Promise<ConflictRecord[]>;
  resolve(rec: ConflictRecord, choice: ConflictChoice): Promise<ResolveOutcome>;
  compare(rec: ConflictRecord): void;
  isText(path: string): boolean;
  isBusy(): boolean;
  done(resolved: number): void;
}

export class ConflictModal extends PluginModal {
  private records: ConflictRecord[] = [];
  private readonly refusals = new Map<string, string>();
  private resolved = 0;

  constructor(app: App, private readonly host: ConflictModalHost) {
    super(app);
  }

  protected render(): void {
    this.setTitle(t("conflicts.title"));
    void this.reload();
  }

  onClose(): void {
    super.onClose();
    if (this.resolved > 0) this.host.done(this.resolved);
  }

  private async reload() {
    this.records = await this.host.list();
    this.draw();
  }

  private draw() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.records.length === 0) {
      contentEl.createEl("p", { text: t("conflicts.none") });
      this.buttonRow(contentEl).createEl("button", { text: t("modal.close") }).addEventListener("click", () => this.close());
      return;
    }
    contentEl.createEl("p", { cls: "vgs-muted", text: t("conflicts.intro") });
    if (this.host.isBusy()) contentEl.createEl("p", { cls: "vgs-warning", text: t("modal.busy") });

    const list = contentEl.createDiv({ cls: "vgs-conflict-list" });
    for (const rec of this.records) {
      const key = `${rec.path}\u0000${rec.conflictPath}`;
      const item = list.createDiv({ cls: "vgs-conflict" });
      item.createDiv({ cls: "vgs-conflict-path", text: rec.path });
      item.createDiv({ cls: "vgs-muted", text: t("conflicts.copy", { path: rec.conflictPath }) });
      const refusal = this.refusals.get(key);
      if (refusal) item.createDiv({ cls: "vgs-error", text: refusal });
      const row = item.createDiv({ cls: "vgs-button-row vgs-left" });
      const act = (label: string, choice: ConflictChoice, cls = "") => {
        row.createEl("button", { cls, text: label }).addEventListener("click", () => { void this.apply([rec], choice); });
      };
      act(t("conflicts.keepLocal"), "keepLocal");
      act(t("conflicts.keepRemote"), "keepRemote");
      act(t("conflicts.keepBoth"), "keepBoth");
      row.createEl("button", { text: t("conflicts.compare") }).addEventListener("click", () => { this.close(); this.host.compare(rec); });
      if (this.host.isText(rec.path)) act(t("conflicts.edit"), "editManually");
    }

    const bulk = this.buttonRow(contentEl);
    for (const [label, choice] of [[t("conflicts.allLocal"), "keepLocal"], [t("conflicts.allRemote"), "keepRemote"], [t("conflicts.allBoth"), "keepBoth"]] as const) {
      bulk.createEl("button", { text: label }).addEventListener("click", () => { void this.apply(this.records, choice); });
    }
  }

  private async apply(recs: ConflictRecord[], choice: ConflictChoice) {
    if (this.host.isBusy()) { this.draw(); return; }
    for (const rec of [...recs]) {
      const key = `${rec.path}\u0000${rec.conflictPath}`;
      const out = await this.host.resolve(rec, choice);
      if (out.status === "refused") this.refusals.set(key, out.reason);
      else { this.refusals.delete(key); if (out.status === "resolved") this.resolved++; }
    }
    await this.reload();
  }
}
