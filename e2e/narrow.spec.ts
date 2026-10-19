import { test, expect, graphFor, type PackmanPage } from "./fixtures";

const ROUTES: { name: string; route: string }[] = [
  { name: "Updates", route: "/updates" },
  { name: "Installed packages", route: "/installed" },
  { name: "Search packages", route: "/search?q=linux" },
  { name: "History", route: "/history" },
  { name: "Cache", route: "/cache" },
  { name: "Keyring", route: "/keyring" },
  { name: "Mirrors", route: "/mirrors" },
  { name: "Repositories", route: "/repositories" },
  { name: "Signoffs", route: "/signoffs" },
];

async function expectNoHorizontalScroll(pacman: PackmanPage) {
  const { scrollWidth, clientWidth } = await pacman.frame.locator("html").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth, `scrollWidth ${scrollWidth} exceeds clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
}

async function openNarrow(pacman: PackmanPage, route: string) {
  await pacman.navigateToPlugin(route);
  await pacman.page.setViewportSize({ width: 360, height: 740 });
  await pacman.waitForLoading();
}

test.describe("Narrow viewport", () => {
  for (const { name, route } of ROUTES) {
    test(`${name} does not scroll sideways at 360 px`, async ({ pacman }) => {
      await openNarrow(pacman, route);
      await expectNoHorizontalScroll(pacman);
    });
  }

  test("the dependency graph does not scroll sideways at 360 px", async ({ pacman }) => {
    await openNarrow(pacman, "/installed?filter=graph");
    await graphFor(pacman, "bash");
    await expectNoHorizontalScroll(pacman);

    await pacman.panel.getByRole("button", { name: "Show graph options" }).click();
    await expect(pacman.panel.getByRole("slider", { name: "Depth", exact: true })).toBeVisible();
    await expectNoHorizontalScroll(pacman);
  });

  test("a collapsed filter toolbar still names the active filter", async ({ pacman }) => {
    await openNarrow(pacman, "/installed?filter=explicit");
    await expect(pacman.panel.getByRole("button", { name: "Show filters" })).toBeVisible();
    await expect(pacman.panel.getByText(/Showing Explicit/)).toBeVisible();
    await expectNoHorizontalScroll(pacman);
  });
});
