import { test, expect } from "./fixtures";

test.describe("package navigation", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.page.setViewportSize({ width: 1600, height: 1000 });
    await pacman.navigateToPlugin();
  });

  test("keeps the installed search beside a drawer and restores focus when it closes", async ({ pacman }) => {
    await pacman.switchTab("Installed packages");
    const search = pacman.panel.getByRole("textbox", { name: "Search installed packages" });
    await search.fill("htop");
    const trigger = pacman.panel.getByRole("button", { name: "htop", exact: true });
    await trigger.click();
    const details = pacman.panel.locator('[data-details-for="htop"]');
    await expect(details).toHaveAttribute("role", "region");
    await expect(details.getByRole("heading", { level: 2 })).toContainText("htop");
    await expect(search).toBeVisible();
    await expect(search).toHaveValue("htop");
    await expect(pacman.frame.getByRole("dialog")).toHaveCount(0);

    await details.getByRole("button", { name: "Close package details", exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(search).toHaveValue("htop");
  });

  test("Back closes routed package details without losing the search", async ({ pacman }) => {
    await pacman.page.goto("/pacman#/installed?q=htop");
    await expect(pacman.frame.getByRole("tab", { name: "Installed packages", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(pacman.panel.getByRole("textbox", { name: "Search installed packages" })).toHaveValue("htop");
    await pacman.page.goto("/pacman#/installed?q=htop&pkg=htop");
    const details = pacman.panel.locator('[data-details-for="htop"]');
    await expect(details.getByRole("button", { name: "Close package details", exact: true })).toBeVisible();

    await pacman.page.goBack();
    await expect(pacman.frame.getByRole("tab", { name: "Installed packages", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(details).toHaveCount(0);
    await expect(pacman.panel.getByRole("textbox", { name: "Search installed packages" })).toHaveValue("htop");
    await expect(pacman.panel.getByRole("button", { name: "htop", exact: true })).toBeVisible();
  });
});
