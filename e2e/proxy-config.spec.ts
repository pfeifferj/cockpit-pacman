import { test, expect } from "./fixtures";
import { guestCommand } from "./guest";

test("proxy policy guards native and HTTP transfers while preserving local operations", async ({ pacman }) => {
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "Requires the disposable guest");
  test.setTimeout(120000);
  await pacman.navigateToPlugin();
  const checks = JSON.parse(await guestCommand(pacman.frame,
    ["python", "/usr/local/libexec/cockpit-pacman-e2e/proxy-config.py"])) as string[];
  expect(checks).toEqual([
    "invalid policy blocks HTTP, database, install, archive and keyring transfers",
    "offline queries, removal and signed cached installation survive invalid policy",
    "scheduled policy failure exits nonzero and records a credential-safe failure",
    "unreadable policy fails closed; direct mode clears inherited aliases",
    "unsafe permissions, credential exposure, symlinks and FIFOs are refused",
    "inherited proxy bypass never authorizes independent keyring networking",
  ]);
});
