// Simulates "the app was killed here": once dead, every vault, state and remote
// operation of that device throws until revived. Shared by the fakes.
export class KillSwitch {
  dead = false;
  kill() { this.dead = true; }
  revive() { this.dead = false; }
  check(what: string) {
    if (this.dead) throw new AppKilledError(what);
  }
}

export class AppKilledError extends Error {
  constructor(what: string) {
    super(`app killed during ${what}`);
    this.name = "AppKilledError";
  }
}
