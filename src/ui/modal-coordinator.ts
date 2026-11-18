// Modal rule (§10): only one plugin modal at a time, and never open a modal
// synchronously from another modal's close or from inside the settings tab.
// ObsSync opened a modal from a closing modal and got a black screen on mobile.
// Every plugin modal is opened through here: close the current one, wait one
// frame, then open the next. Pure (frame wait injected) so it can be tested.

export interface ModalLike {
  open(): void;
  close(): void;
  /** Register a callback for when the modal closes (by the user or by close()). */
  onClosed(cb: () => void): void;
}

export class ModalCoordinator {
  private current: ModalLike | null = null;
  private generation = 0;

  constructor(private readonly nextFrame: () => Promise<void>) {}

  get isOpen(): boolean { return this.current !== null; }

  /** Open a modal (built lazily, after the previous one is gone and a frame has passed). */
  async open(make: () => ModalLike): Promise<void> {
    const gen = ++this.generation;
    if (this.current) {
      const prev = this.current;
      this.current = null;
      prev.close();
    }
    await this.nextFrame();
    if (gen !== this.generation) return; // a newer open() won the race
    const m = make();
    this.current = m;
    m.onClosed(() => { if (this.current === m) this.current = null; });
    m.open();
  }

  closeAll() {
    this.generation++;
    const m = this.current;
    this.current = null;
    m?.close();
  }
}
