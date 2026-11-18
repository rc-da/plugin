import { Modal } from "obsidian";
import type { ModalLike } from "./modal-coordinator";
import { t } from "../i18n";

/** Base for every plugin modal: close callbacks for ModalCoordinator, shared helpers. */
export abstract class PluginModal extends Modal implements ModalLike {
  private readonly closedCbs: (() => void)[] = [];

  onClosed(cb: () => void): void { this.closedCbs.push(cb); }

  onOpen(): void {
    this.modalEl.addClass("vgs-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    for (const cb of this.closedCbs.splice(0)) cb();
  }

  protected abstract render(): void;

  /** A scrolling list of paths, capped so a huge list cannot freeze a phone. */
  protected pathList(parent: HTMLElement, paths: readonly string[], cap = 300): void {
    const ul = parent.createEl("ul", { cls: "vgs-path-list" });
    for (const p of paths.slice(0, cap)) ul.createEl("li", { text: p });
    if (paths.length > cap) ul.createEl("li", { cls: "vgs-muted", text: t("modal.andMore", { n: paths.length - cap }) });
  }

  protected buttonRow(parent: HTMLElement): HTMLElement {
    return parent.createDiv({ cls: "vgs-button-row" });
  }
}
