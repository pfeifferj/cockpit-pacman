import { test, expect, graphFor, GRAPH_NODES, type PackmanPage } from "./fixtures";


async function nodeNames(pacman: PackmanPage): Promise<string[]> {
  const names = await pacman.panel.locator(`${GRAPH_NODES} text`).allTextContents();
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

    const drawn = await pacman.panel.locator(GRAPH_NODES).count();
    await expect(pacman.panel.getByText(`${drawn} nodes`)).toBeVisible();

    const label = await pacman.panel.getByText(/^\d+ edges$/).innerText();
    expect(Number(label.split(" ")[0])).toBeGreaterThanOrEqual(drawn - 1);
  });

  test("reverses to what depends on a package", async ({ pacman }) => {
    await graphFor(pacman, "bash");
    const forward = await nodeNames(pacman);

    await pacman.panel.locator('.pf-v6-c-toggle-group__button:has-text("Reverse")').click();
    await pacman.waitForLoading();
    await expect(pacman.panel.locator(GRAPH_NODES).first()).toBeAttached({ timeout: 30000 });

    const reverse = await nodeNames(pacman);
    expect(reverse).toContain("bash");
    expect(reverse).not.toEqual(forward);
  });

  for (const { direction, root, optionalNode } of [
    { direction: "Forward", root: "glibc", optionalNode: "gd" },
    { direction: "Reverse", root: "gd", optionalNode: "glibc" },
  ]) {
    test(`redraws ${direction.toLowerCase()} optional dependencies when their depth changes`, async ({ pacman }) => {
      await pacman.panel.getByRole("button", { name: direction, exact: true }).click();
      await graphFor(pacman, root);

      const optional = pacman.panel.getByRole("slider", { name: "Optional dependency depth", exact: true });
      const optionalEdges = pacman.panel.locator("svg g.links line[stroke-dasharray]");

      await expect(optional).toHaveAttribute("aria-valuenow", "0");
      const required = await nodeNames(pacman);
      expect(required).toContain(root);
      expect(required).not.toContain(optionalNode);
      await expect(optionalEdges).toHaveCount(0);

      await optional.press("ArrowRight");
      await expect(optional).toHaveAttribute("aria-valuenow", "1");
      await expect.poll(() => nodeNames(pacman)).toContain(optionalNode);
      await expect.poll(() => optionalEdges.count()).toBeGreaterThan(0);

      await optional.press("ArrowLeft");
      await expect(optional).toHaveAttribute("aria-valuenow", "0");
      await expect.poll(() => nodeNames(pacman)).toEqual(required);
      await expect(optionalEdges).toHaveCount(0);
    });
  }

  test("limits optional reverse links by their distance from libde265", async ({ pacman }) => {
    await pacman.panel.getByRole("button", { name: "Reverse", exact: true }).click();
    const depth = pacman.panel.getByRole("slider", { name: "Depth", exact: true });
    const optional = pacman.panel.getByRole("slider", { name: "Optional dependency depth", exact: true });
    for (let step = 0; step < 3; step++) await depth.press("ArrowRight");
    for (let step = 0; step < 2; step++) await optional.press("ArrowRight");
    await expect(depth).toHaveAttribute("aria-valuenow", "4");
    await expect(optional).toHaveAttribute("aria-valuenow", "2");
    await graphFor(pacman, "libde265");

    const shallow = await nodeNames(pacman);
    expect(shallow).toContain("libde265");
    expect(shallow).not.toContain("glibc");

    await optional.press("ArrowRight");
    await expect(optional).toHaveAttribute("aria-valuenow", "3");
    await expect.poll(() => nodeNames(pacman)).toContain("glibc");

    await optional.press("ArrowLeft");
    await expect(optional).toHaveAttribute("aria-valuenow", "2");
    await expect.poll(() => nodeNames(pacman)).toEqual(shallow);
  });

  test("says so when the package does not exist", async ({ pacman }) => {
    const search = pacman.panel.getByPlaceholder("Search packages...");
    await search.fill("no-such-package-anywhere");
    await search.press("Enter");
    await pacman.waitForLoading();

    await expect(pacman.panel.getByText("Package not found")).toBeVisible({ timeout: 30000 });
    await expect(pacman.panel.locator(GRAPH_NODES)).toHaveCount(0);
  });
});
