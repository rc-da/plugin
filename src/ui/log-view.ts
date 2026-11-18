import { type App, Notice } from "obsidian";
import type { LogLine, RingLogger } from "../core/log";
import { t } from "../i18n";
import { PluginModal } from "./plugin-modal";

// Log viewer (§8): the redacted ring buffer, newest last, copyable for bug reports.

export class LogModal extends PluginModal {
  private onlyProblems = false;

  constructor(app: App, private readonly logger: RingLogger) {
    super(app);
  }

  protected render(): void {
    this.setTitle(t("log.title"));
    this.draw();
  }

  private draw() {
    const { contentEl } = this;
    contentEl.empty();
    const tools = contentEl.createDiv({ cls: "vgs-button-row vgs-left" });
    const label = tools.createEl("label", { cls: "vgs-inline" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.onlyProblems;
    label.appendText(` ${t("log.onlyProblems")}`);
    box.addEventListener("change", () => { this.onlyProblems = box.checked; this.draw(); });
    tools.createEl("button", { text: t("log.copy") }).addEventListener("click", () => {
      void navigator.clipboard.writeText(this.logger.format()).then(() => new Notice(t("notice.logCopied")));
    });

    const lines = this.logger.entries().filter(l => !this.onlyProblems || l.level === "warn" || l.level === "error");
    const pre = contentEl.createEl("pre", { cls: "vgs-log" });
    if (lines.length === 0) pre.setText(t("log.empty"));
    for (const l of lines) pre.createDiv({ cls: `vgs-log-${l.level}`, text: formatLine(l) });
    pre.scrollTop = pre.scrollHeight;
  }
}

function formatLine(l: LogLine): string {
  return `${new Date(l.at).toLocaleTimeString()} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`;
}
