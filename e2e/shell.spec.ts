import { URL } from "node:url";
import { test, expect, type PackmanPage } from "./fixtures";
import type { CacheInfo } from "../src/bindings";
import { BACKEND, guestCommand } from "./guest";

const SEARCH_INPUT = 'input[type="search"], input[placeholder*="Search"]';

const TABS: { title: string; slug: string }[] = [
  { title: "Updates", slug: "updates" },
  { title: "Installed packages", slug: "installed" },
  { title: "Search packages", slug: "search" },
  { title: "History", slug: "history" },
  { title: "Cache", slug: "cache" },
  { title: "Keyring", slug: "keyring" },
  { title: "Mirrors", slug: "mirrors" },
  { title: "Repositories", slug: "repositories" },
];

test.describe("Shell", () => {
  test("'/' focuses the package jump inside the plugin frame", async ({ pacman }) => {
    await pacman.navigateToPlugin();
    const jump = pacman.frame.getByRole("searchbox", { name: "Go to package or tab" })
      .or(pacman.frame.getByRole("textbox", { name: "Go to package or tab" }));
    await expect(jump).toBeVisible();

    const updates = pacman.tab("Updates");
    await updates.click();
    await expect(updates).toBeFocused();
    const shellUrl = pacman.page.url();
    await updates.press("/");

    await expect(jump).toBeFocused();
    await expect(jump).toHaveValue("");
    expect(pacman.page.url()).toBe(shellUrl);
  });

  test("'?' opens the shortcut list inside the plugin frame", async ({ pacman }) => {
    await pacman.navigateToPlugin();
    const updates = pacman.tab("Updates");
    await updates.click();
    await expect(updates).toBeFocused();
    const shellUrl = pacman.page.url();
    await updates.press("?");

    await expect(pacman.frame.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    expect(pacman.page.url()).toBe(shellUrl);

    await pacman.page.keyboard.press("?");
    await expect(pacman.frame.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  });

  test("'/' typed into a text input stays in that input", async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Installed packages");
    const search = pacman.panel.locator(SEARCH_INPUT).first();
    await search.click();
    await pacman.page.keyboard.type("lib/x");

    await expect(search).toBeFocused();
    await expect(search).toHaveValue("lib/x");
  });

  test("a deep link opens Installed packages filtered by its query", async ({ pacman }) => {
    await pacman.navigateToPlugin("/installed?q=linux");

    await expect(pacman.tab("Installed packages")).toHaveAttribute("aria-selected", "true");
    await pacman.waitForLoading();
    const search = pacman.panel.locator(SEARCH_INPUT).first();
    await expect(search).toHaveValue("linux");
    const rows = pacman.panel.locator("table tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 30000 });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/linux/i);
    }
  });

  test("Back after an overview jump returns to Updates", async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.waitForLoading();
    await expect(pacman.tab("Updates")).toHaveAttribute("aria-selected", "true");

    await pacman.panel.getByRole("button", { name: /cache/i }).first().click();
    await expect(pacman.tab("Cache")).toHaveAttribute("aria-selected", "true");

    await pacman.page.goBack();
    await expect(pacman.tab("Updates")).toHaveAttribute("aria-selected", "true");
    await expect(pacman.page.frameLocator('iframe[name*="pacman"], iframe[src*="pacman"]')
      .locator('[role="tablist"]').first()).toBeVisible();
  });

  test.describe("at a phone width", () => {
    test("reaches every tab in at most two taps", async ({ pacman }) => {
      await pacman.navigateToPlugin();
      await pacman.page.setViewportSize({ width: 400, height: 800 });
      const overflow = pacman.frame.locator('[role="tab"][aria-haspopup="menu"]');

      for (const { title, slug } of TABS) {
        const direct = pacman.frame.locator('[role="tab"]:not([aria-haspopup])', { hasText: title });
        const box = await direct.first().isVisible() ? await direct.first().boundingBox() : null;
        const width = pacman.page.viewportSize()?.width ?? 400;
        if (box && box.x >= 0 && box.x + box.width <= width) {
          await direct.first().click();
        } else {
          await overflow.click();
          await pacman.frame.getByRole("menuitem", { name: title, exact: true }).click();
        }

        const others = TABS.filter(t => t.slug !== slug).map(t => t.slug);
        await expect.poll(() => {
          const hash = new URL(pacman.page.url()).hash;
          return slug === "updates"
            ? !others.some(o => hash.includes(o))
            : hash.includes(slug);
        }).toBe(true);
        await expect(pacman.frame.locator('[role="tabpanel"]:visible')).toHaveCount(1);
      }
    });
  });

  for (const slug of ["history", "cache"]) {
    test(`#/${slug}?pkg= opens the details drawer beside the list, and Back closes it`, async ({ pacman }) => {
      await pacman.navigateToPlugin(`/${slug}`);
      const pkg = slug === "cache" ? await cachedPackage(pacman) : "pacman";
      await pacman.waitForLoading();
      await pacman.page.goto(`/pacman#/${slug}?pkg=${pkg}`);

      await expectDrawer(pacman, pkg);
      await pacman.page.goBack();
      await expect(pacman.tab(slug === "cache" ? "Cache" : "History")).toHaveAttribute("aria-selected", "true");
      await expect(pacman.panel.locator("[data-details-for]")).toHaveCount(0);
      await expect(pacman.frame.getByRole("dialog")).toHaveCount(0);
    });
  }
});

async function cachedPackage(pacman: PackmanPage): Promise<string> {
  const info: CacheInfo = JSON.parse(await guestCommand(pacman.frame, [BACKEND, "cache-info"], false));
  const name = info.groups[0]?.name;
  if (!name) throw new Error("needs a non-empty package cache (updates-pending template)");
  return name;
}

async function expectDrawer(pacman: PackmanPage, pkg: string) {
  const details = pacman.panel.locator(`[data-details-for="${pkg}"]`);
  await expect(details.getByRole("button", { name: "Close package details" })).toBeVisible({ timeout: 30000 });
  await expect(pacman.frame.locator('[role="dialog"]:not([data-details-for])')).toHaveCount(0);
}
