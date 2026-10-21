import { describe, expect, it } from "vitest";
import {
  KillSwitch,
  type KillSwitchChange,
  type KillSwitchStore,
} from "./kill-switch.js";

class FakeStore implements KillSwitchStore {
  value = false;
  failing = false;
  reads = 0;

  async read(): Promise<boolean> {
    this.reads += 1;
    if (this.failing) throw new Error("db down");
    return this.value;
  }

  async set(change: KillSwitchChange): Promise<void> {
    this.value = change.enabled;
  }
}

function setup(forcedOn = false) {
  const store = new FakeStore();
  let t = 0;
  const errors: unknown[] = [];
  const killSwitch = new KillSwitch({
    store,
    forcedOn,
    maxAgeMs: 30_000,
    now: () => t,
    onError: (error) => errors.push(error),
  });
  return {
    store,
    killSwitch,
    errors,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("KillSwitch", () => {
  it("is on until the store has been read once", async () => {
    const { killSwitch } = setup();
    expect(killSwitch.isOn()).toBe(true);
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(false);
  });

  it("follows the stored value without a restart", async () => {
    const { store, killSwitch } = setup();
    await killSwitch.refresh();
    store.value = true;
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(true);
    store.value = false;
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(false);
  });

  it("keeps the last value through a short outage", async () => {
    const { store, killSwitch, errors, advance } = setup();
    await killSwitch.refresh();
    store.failing = true;
    advance(10_000);
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("turns on when the store has not answered for too long", async () => {
    const { store, killSwitch, advance } = setup();
    await killSwitch.refresh();
    store.failing = true;
    advance(30_001);
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(true);

    store.failing = false;
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(false);
  });

  it("stays on when AI_KILL_SWITCH is set, whatever is stored", async () => {
    const { killSwitch } = setup(true);
    await killSwitch.refresh();
    expect(killSwitch.isOn()).toBe(true);
  });

  it("start() reads before returning and stop() ends the refresh", async () => {
    const { store, killSwitch } = setup();
    await killSwitch.start();
    expect(store.reads).toBe(1);
    expect(killSwitch.isOn()).toBe(false);
    killSwitch.stop();
  });
});
