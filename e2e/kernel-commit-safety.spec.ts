import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, guestCommand } from "./guest";

const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/kernel-fixture.py";
const mode = process.env.COCKPIT_KERNEL_REINSTALL === "1" ? "reinstall" : "upgrade";

interface KernelState {
  mode: string;
  target_version: string;
  old_version: string;
  version: string | null;
  barrier: boolean;
  missing: string[];
  artifacts: string[];
  post: boolean;
  pids: number[];
  locked: boolean;
}

async function fixture(pacman: PackmanPage, ...args: string[]) {
  return guestCommand(pacman.frame, [FIXTURE, ...args]);
}

async function state(pacman: PackmanPage): Promise<KernelState> {
  return JSON.parse(await fixture(pacman, "state"));
}

test.describe("real kernel commit hooks", () => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "requires the disposable guest kernel fixture");
  test.setTimeout(600000);

  test.afterEach(async ({ pacman }) => {
    await fixture(pacman, "cleanup");
  });

  test(`regenerates kernel and initramfs after SIGTERM during ${mode}`, async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await fixture(pacman, "setup", "--mode", mode);
    const prepared = await state(pacman);
    if (mode === "upgrade") expect(prepared.old_version).not.toBe(prepared.target_version);
    await pacman.frame.locator("body").evaluate((_body, args) => {
      const cockpit = Reflect.get(globalThis, "cockpit") as {
        spawn(args: string[], options: { superuser: "require"; err: "message" }): Promise<string> & {
          stream(callback: (chunk: string) => void): void;
        };
      };
      const process = cockpit.spawn(args, { superuser: "require", err: "message" });
      const result = { output: "", done: false, error: "" };
      Reflect.set(globalThis, "kernelCommitRun", result);
      process.stream(chunk => { result.output += chunk; });
      void process.then(() => { result.done = true; }, error => {
        result.done = true;
        result.error = String(error);
      });
    }, [BACKEND, "downgrade", "linux", prepared.target_version, "900"]);
    await expect.poll(async () => (await state(pacman)).barrier, { timeout: 60000 }).toBe(true);
    const paused = await state(pacman);
    expect(paused.pids).toHaveLength(1);
    expect(paused.locked).toBe(true);
    expect(paused.post).toBe(false);
    if (mode === "upgrade") expect(paused.missing.sort()).toEqual(paused.artifacts.sort());
    await fixture(pacman, "term");
    await fixture(pacman, "release");
    await expect.poll(async () => {
      const current = await state(pacman);
      return { version: current.version, post: current.post, pids: current.pids, locked: current.locked };
    }, { timeout: 180000 }).toEqual({ version: prepared.target_version, post: true, pids: [], locked: false });
    const artifacts = JSON.parse(await fixture(pacman, "verify"));
    expect(artifacts.mode).toBe(mode);
    expect(artifacts.kernels.length).toBeGreaterThan(0);
    expect(artifacts.images.length).toBeGreaterThan(0);
    await expect.poll(() => pacman.frame.locator("body").evaluate(() =>
      (Reflect.get(globalThis, "kernelCommitRun") as { done: boolean }).done)).toBe(true);
    const result = await pacman.frame.locator("body").evaluate(() => Reflect.get(globalThis, "kernelCommitRun") as {
      done: boolean; error: string; output: string;
    });
    expect(result.error).toBe("");
    const events = result.output.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(event => event.type === "complete")?.success).toBe(true);
  });
});
