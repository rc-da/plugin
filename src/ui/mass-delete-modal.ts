import type { App } from "obsidian";
import type { GuardApprovals } from "../core/guards";
import type { GuardStop } from "../core/types";
import { t } from "../i18n";
import { PluginModal } from "./plugin-modal";

// Guard stops (§5.6) shown to the user after a manual sync, or from the status bar
// after a silent one. Confirming re-runs the sync with approvals that cover exactly
// what is listed here; core re-checks, so a plan that changed meanwhile asks again.

export class GuardModal extends PluginModal {
  constructor(app: App, private readonly stop: Exclude<GuardStop, { kind: "custom" }>, private readonly onApprove: (a: GuardApprovals) => void) {
    super(app);
  }

  protected render(): void {
    const { contentEl } = this;
    const s = this.stop;
    if (s.kind === "massDelete") {
      this.setTitle(t("guard.massDelete.title"));
      contentEl.createEl("p", { text: t("guard.massDelete.intro") });
      contentEl.createEl("p", { cls: "vgs-muted", text: s.message });
      for (const [label, paths] of [[t("guard.massDelete.local", { n: s.local.length }), s.local], [t("guard.massDelete.remote", { n: s.remote.length }), s.remote]] as const) {
        if (paths.length === 0) continue;
        const details = contentEl.createEl("details", { cls: "vgs-details" });
        details.createEl("summary", { text: label });
        this.pathList(details, paths);
      }
      const row = this.buttonRow(contentEl);
      row.createEl("button", { text: t("modal.cancel") }).addEventListener("click", () => this.close());
      const ok = row.createEl("button", { cls: "mod-warning", text: t("guard.massDelete.confirm") });
      ok.addEventListener("click", () => {
        this.close();
        this.onApprove({ deletions: { local: s.local, remote: s.remote } });
      });
      return;
    }

    // emptyRemote
    this.setTitle(s.head === null ? t("guard.empty.missing.title") : t("guard.empty.title"));
    contentEl.createEl("p", { text: s.message });
    contentEl.createEl("p", { cls: "vgs-muted", text: t("guard.empty.intro") });
    const choice = (cls: string, title: string, desc: string, onClick: (btn: HTMLButtonElement) => void) => {
      const box = contentEl.createDiv({ cls: "vgs-choice" });
      const btn = box.createEl("button", { cls, text: title });
      box.createDiv({ cls: "vgs-muted", text: desc });
      btn.addEventListener("click", () => onClick(btn));
    };
    choice("mod-cta", t("guard.empty.reupload"), t("guard.empty.reupload.desc"), () => {
      this.close();
      this.onApprove({ emptyRemote: { head: s.head, resolution: "reupload" } });
    });
    let armed = false;
    choice("mod-warning", t("guard.empty.delete"), t("guard.empty.delete.desc"), btn => {
      if (!armed) { armed = true; btn.setText(t("guard.empty.deleteConfirm")); return; }
      this.close();
      this.onApprove({ emptyRemote: { head: s.head, resolution: "applyDeletions" } });
    });
    this.buttonRow(contentEl).createEl("button", { text: t("modal.cancel") }).addEventListener("click", () => this.close());
  }
}
