import { test, expect, type PackmanPage } from "./fixtures";
import { BACKEND, FIXTURE, guestCommand } from "./guest";
import { writeFile } from "node:fs/promises";

const PROXY = "/usr/local/libexec/cockpit-pacman-e2e/proxy-fixture.py";
interface RequestRecord {
  kind: string; method?: string; path?: string; target?: string; transport?: string;
  authorized?: boolean; proxy_auth?: boolean; host?: string; atyp?: number;
}

async function configure(pacman: PackmanPage, mode: string) {
  await guestCommand(pacman.frame, [PROXY, "configure", mode]);
}

async function state(pacman: PackmanPage): Promise<{ records: RequestRecord[]; blocked: number }> {
  return JSON.parse(await guestCommand(pacman.frame, [PROXY, "records"]));
}

async function backend(pacman: PackmanPage, args: string[], administrative = true) {
  const output = await guestCommand(pacman.frame, [BACKEND, ...args], administrative);
  for (const secret of ["proxy-user", "fixture-p%40ss", "fixture-p@ss", "wrong-password", "cHJveHktdXNlcjpmaXh0dXJlLXBAc3M="]) {
    expect(output).not.toContain(secret);
  }
  return output.trim().split("\n").map(line => JSON.parse(line));
}

async function resetPackage(pacman: PackmanPage) {
  await guestCommand(pacman.frame, [PROXY, "reset-package"]);
}

function transferred(records: RequestRecord[], pattern: RegExp) {
  return records.some(record => record.kind === "origin" && pattern.test(record.path ?? ""));
}

test.describe("Proxy routing", () => {
  let prepared = false;
  test.skip(process.env.COCKPIT_E2E_FIXTURE !== "1", "Requires isolated guest proxies and firewall");
  test.setTimeout(120000);

  test.beforeEach(async ({ pacman }) => {
    prepared = false;
    await pacman.navigateToPlugin();
    await guestCommand(pacman.frame, [PROXY, "setup"]);
    prepared = true;
  });

  test.afterEach(async ({ pacman }, testInfo) => {
    if (!prepared) return;
    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        const path = testInfo.outputPath("proxy-diagnostics.json");
        await writeFile(path, await guestCommand(pacman.frame, [PROXY, "diagnostics"]));
        await testInfo.attach("proxy-diagnostics", { path, contentType: "application/json" });
      }
    } finally {
      await guestCommand(pacman.frame, [PROXY, "cleanup"]);
      await guestCommand(pacman.frame, [FIXTURE, "secrets-disable"]);
    }
  });

  test("routes user metadata, signoffs and administrative archive transfers through an authenticated HTTP proxy", async ({ pacman }) => {
    const news = (await backend(pacman, ["fetch-news", "30", "true"], false)).pop();
    expect(news).toMatchObject({ items: [{ title: "Proxy news" }] });
    expect(news.stale ?? false).toBe(false);
    const security = (await backend(pacman, ["check-security", "true"], false)).pop();
    expect(security).toMatchObject({ advisories: [] });
    expect(security.stale ?? false).toBe(false);
    expect(security.disabled ?? false).toBe(false);
    const info = (await backend(pacman, ["security-info", "htop"], false)).pop();
    expect(info).toMatchObject({ name: "htop", advisories: [], groups: [], issues: [] });
    expect(info.disabled ?? false).toBe(false);
    expect((await backend(pacman, ["fetch-mirror-status"], false)).pop()).toMatchObject({ total: 1 });
    const probes = await backend(pacman, ["test-mirrors", "http://127.0.0.2:18081/$repo/os/$arch", "10"], false);
    expect(probes.find(event => event.type === "mirror_test")?.result).toMatchObject({ success: true });
    const listing = (await backend(pacman, ["list-archive-versions", "htop"], false)).pop();
    expect(listing.packages).toHaveLength(1);
    await guestCommand(pacman.frame, [FIXTURE, "secrets-enable"]);
    await pacman.page.reload();
    await pacman.switchTab("Signoffs");
    await expect(pacman.panel.getByText("htop", { exact: true }).first()).toBeVisible();
    const metadata = await state(pacman);
    for (const path of ["/news", "/issues/vulnerable.json", "/package/htop.json", "/mirrors", "/archive/h/htop/", "/login/", "/packages/signoffs/json/", "/logout/"]) {
      expect(metadata.records.some(record => record.kind === "origin" && record.path === path)).toBe(true);
    }
    expect(metadata.blocked).toBe(0);
    expect(metadata.records.some(record => record.kind === "origin" && record.method === "HEAD" && record.path === "/core/os/x86_64/core.db")).toBe(true);
    await resetPackage(pacman);
    await guestCommand(pacman.frame, [FIXTURE, "archive-ready"]);
    expect((await backend(pacman, ["downgrade-archive", "htop", listing.packages[0].filename])).pop()).toMatchObject({ success: true });
    const result = await state(pacman);
    expect(result.blocked).toBe(0);
    expect(transferred(result.records, /\.pkg\.tar\.zst$/)).toBe(true);
    expect(transferred(result.records, /\.pkg\.tar\.zst\.sig$/)).toBe(true);
    expect(result.records.filter(record => record.kind === "proxy").every(record => record.authorized)).toBe(true);
    expect(result.records.filter(record => record.kind === "origin").every(record => !record.proxy_auth)).toBe(true);
  });

  test("performs native database and package transfers through a trusted HTTPS proxy and CONNECT", async ({ pacman }) => {
    await configure(pacman, "https");
    expect((await backend(pacman, ["fetch-mirror-status"], false)).pop()).toMatchObject({ total: 1 });
    await resetPackage(pacman);
    expect((await backend(pacman, ["sync-database", "true", "30"])).pop()).toMatchObject({ success: true });
    expect((await backend(pacman, ["install-package", "htop", "30"])).pop()).toMatchObject({ success: true });
    const result = await state(pacman);
    expect(result.blocked).toBe(0);
    expect(result.records.some(record => record.transport === "https" && record.method === "CONNECT" && record.authorized)).toBe(true);
    expect(transferred(result.records, /proxyfixture\.db$/)).toBe(true);
    expect(transferred(result.records, /\.pkg\.tar\.zst$/)).toBe(true);
    expect(transferred(result.records, /\.pkg\.tar\.zst\.sig$/)).toBe(true);
  });

  test("distinguishes SOCKS5 local lookup from SOCKS5h proxy lookup", async ({ pacman }) => {
    await configure(pacman, "socks5h");
    expect((await backend(pacman, ["fetch-mirror-status"], false)).pop()).toMatchObject({ total: 1 });
    await resetPackage(pacman);
    expect((await backend(pacman, ["sync-database", "true", "30"])).pop()).toMatchObject({ success: true });
    let result = await state(pacman);
    expect(result.records.some(record => record.kind === "socks" && record.atyp === 3 && record.host === "only.proxy.invalid")).toBe(true);
    expect(result.records.some(record => record.kind === "dns" && record.host === "only.proxy.invalid")).toBe(false);
    expect(result.blocked).toBe(0);
    await configure(pacman, "socks5");
    await resetPackage(pacman);
    const failed = (await backend(pacman, ["sync-database", "true", "30"])).pop();
    expect(failed.code).toBeDefined();
    result = await state(pacman);
    expect(result.records.some(record => record.kind === "dns" && record.host === "only.proxy.invalid")).toBe(true);
    expect(result.records.some(record => record.kind === "origin")).toBe(false);
    expect(result.blocked).toBe(0);
    await configure(pacman, "socks-ip");
    expect((await backend(pacman, ["sync-database", "true", "30"])).pop()).toMatchObject({ success: true });
    result = await state(pacman);
    expect(result.records.some(record => record.kind === "socks" && record.atyp === 1 && record.host === "127.0.0.2")).toBe(true);
  });

  test("applies explicit direct mode, CIDR bypass and bypass after a redirect", async ({ pacman }) => {
    for (const mode of ["direct", "bypass", "redirect"]) {
      await configure(pacman, mode);
      expect((await backend(pacman, ["fetch-mirror-status"], false)).pop()).toMatchObject({ code: "network_error" });
      const result = await state(pacman);
      expect(result.blocked).toBeGreaterThan(0);
      expect(result.records.filter(record => record.kind === "proxy")).toHaveLength(mode === "redirect" ? 1 : 0);
      expect(transferred(result.records, /^\/mirrors$/)).toBe(false);
    }
  });

  test("fails without direct fallback or credential disclosure", async ({ pacman }) => {
    for (const mode of ["bad-auth", "unreachable", "bad-url"]) {
      await configure(pacman, mode);
      expect((await backend(pacman, ["fetch-mirror-status"], false)).pop().code).toBe(mode === "bad-url" ? "validation_error" : "network_error");
      expect((await backend(pacman, ["sync-database", "true", "10"])).pop().code).toBeDefined();
      const result = await state(pacman);
      expect(result.blocked).toBe(0);
      expect(result.records.some(record => record.kind === "origin")).toBe(false);
      const scheduled = JSON.parse(await guestCommand(pacman.frame, [PROXY, "scheduled"]));
      expect(scheduled.returncode).not.toBe(0);
      expect(scheduled.record.status).toBe("failed");
      const afterScheduled = await state(pacman);
      expect(afterScheduled.blocked).toBe(0);
      expect(afterScheduled.records.some(record => record.kind === "origin")).toBe(false);
    }
  });

  test("runs a scheduled upgrade using the file policy without shell proxy variables", async ({ pacman }) => {
    await resetPackage(pacman);
    const result = JSON.parse(await guestCommand(pacman.frame, [PROXY, "scheduled"]));
    expect(result.returncode).toBe(0);
    expect(result.record).toMatchObject({ status: "ok", packages_upgraded: 1 });
    const traffic = await state(pacman);
    expect(traffic.blocked).toBe(0);
    expect(transferred(traffic.records, /proxyfixture\.db$/)).toBe(true);
    expect(transferred(traffic.records, /\.pkg\.tar\.zst$/)).toBe(true);
    expect(transferred(traffic.records, /\.pkg\.tar\.zst\.sig$/)).toBe(true);
  });

  test("requires explicit delegation to an existing dirmngr", async ({ pacman }) => {
    expect(JSON.parse(await guestCommand(pacman.frame, [PROXY, "keyring"]))).toEqual({ denied: true, external: true, same_daemon: true });
  });
});
