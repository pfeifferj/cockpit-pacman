import { test, expect, type PackmanPage } from "./fixtures";

const NODES = "svg g.nodes > g";

async function graphFor(pacman: PackmanPage, name: string) {
  const search = pacman.panel.getByPlaceholder("Search packages...");
  await search.fill(name);
  await search.press("Enter");
  await pacman.waitForLoading();
  await expect(pacman.panel.locator(NODES).first()).toBeAttached({ timeout: 30000 });
}

async function nodeNames(pacman: PackmanPage): Promise<string[]> {
  const names = await pacman.panel.locator(`${NODES} text`).allTextContents();
  return names.map((n) => n.trim()).sort();
}

test.describe("Dependency Graph", () => {
  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    await pacman.switchTab("Installed Packages");
    await pacman.waitForLoading();
    await pacman.selectFilter("Graph");
  });

  test("draws what a package depends on", async ({ pacman }) => {
    await graphFor(pacman, "bash");

    const names = await nodeNames(pacman);
    expect(names).toContain("bash");
    expect(names.length).toBeGreaterThan(1);
  });

  test("counts the nodes and edges it drew", async ({ pacman }) => {
    await graphFor(pacman, "bash");

    const drawn = await pacman.panel.locator(NODES).count();
    await expect(pacman.panel.getByText(`${drawn} nodes`)).toBeVisible();

    const label = await pacman.panel.getByText(/^\d+ edges$/).innerText();
    expect(Number(label.split(" ")[0])).toBeGreaterThanOrEqual(drawn - 1);
  });

  test("reverses to what depends on a package", async ({ pacman }) => {
    await graphFor(pacman, "bash");
    const forward = await nodeNames(pacman);

    await pacman.panel.locator('.pf-v6-c-toggle-group__button:has-text("Reverse")').click();
    await pacman.waitForLoading();
    await expect(pacman.panel.locator(NODES).first()).toBeAttached({ timeout: 30000 });

    const reverse = await nodeNames(pacman);
    expect(reverse).toContain("bash");
    expect(reverse).not.toEqual(forward);
  });

  test("says so when the package does not exist", async ({ pacman }) => {
    const search = pacman.panel.getByPlaceholder("Search packages...");
    await search.fill("no-such-package-anywhere");
    await search.press("Enter");
    await pacman.waitForLoading();

    await expect(pacman.panel.getByText("Package not found")).toBeVisible({ timeout: 30000 });
    await expect(pacman.panel.locator(NODES)).toHaveCount(0);
  });
});
