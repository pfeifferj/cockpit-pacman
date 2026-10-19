import { test, expect } from "./fixtures";

test.describe("Keyring Tab", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Keyring");
    await pacman.waitForLoading();
  });

  test("lists the keys pacman trusts", async ({ pacman }) => {
    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("shows a fingerprint for each key", async ({ pacman }) => {
    const fingerprints = pacman.panel.locator('td[data-label="Fingerprint"]');
    await expect(fingerprints.first()).toBeVisible({ timeout: 30000 });

    await expect(fingerprints.first()).toHaveText(/^[0-9A-Fa-f]{40}$/);
  });

  test("offers to refresh the keys", async ({ pacman }) => {
    await expect(
      pacman.panel.getByRole("button", { name: /^Refresh$/i })
    ).toBeVisible({ timeout: 30000 });
  });

  test("paginates a keyring larger than one page", async ({ pacman }) => {
    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });

    await expect(pacman.panel.locator('[class*="pagination"]').first()).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(100);
  });
});


test("rejects malformed fingerprints and short key ids before starting an import", async ({ pacman }) => {
  await pacman.navigateToPlugin();
  await pacman.switchTab("Keyring");
  await pacman.panel.getByRole("button", { name: "Add key", exact: true }).click();
  const dialog = pacman.frame.getByRole("dialog", { name: "Add key", exact: true });
  await pacman.frame.locator("body").evaluate(() => {
    const cockpit = Reflect.get(globalThis, "cockpit") as { spawn: (...args: unknown[]) => unknown };
    const original = cockpit.spawn;
    const probe = { original, attempts: 0 };
    Reflect.set(globalThis, "keyImportProbe", probe);
    cockpit.spawn = (...args) => {
      const command = args[0];
      if (Array.isArray(command) && command.some(arg => arg === "receive-key" || arg === "lsign-key")) {
        probe.attempts++;
        throw new Error("Unexpected key import for invalid fingerprint");
      }
      return original.apply(cockpit, args);
    };
  });
  try {
    const input = dialog.getByRole("textbox", { name: "Key fingerprint", exact: true });
    const fetch = dialog.getByRole("button", { name: "Fetch", exact: true });
    for (const [value, message] of [
      ["not-a-fingerprint", /^A fingerprint is 40 hexadecimal characters/],
      ["0FA8E1BCB1F1A2C0", /^This is a key id\. Enter the full 40-character fingerprint/],
    ] as const) {
      await input.fill(value);
      await expect(dialog.getByText(message)).toBeVisible();
      await expect(fetch).toBeDisabled();
      await input.press("Enter");
      await fetch.click({ force: true });
      await expect(dialog.getByText("Key not fetched", { exact: true })).toHaveCount(0);
      await expect(dialog.getByText(/Fetching the key from/)).toHaveCount(0);
    }
    const attempts = await pacman.frame.locator("body").evaluate(() =>
      (Reflect.get(globalThis, "keyImportProbe") as { attempts: number }).attempts,
    );
    expect(attempts).toBe(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await pacman.frame.locator("body").evaluate(() => {
      const cockpit = Reflect.get(globalThis, "cockpit") as { spawn: unknown };
      const probe = Reflect.get(globalThis, "keyImportProbe") as { original: unknown };
      cockpit.spawn = probe.original;
      Reflect.deleteProperty(globalThis, "keyImportProbe");
    });
  }
});
