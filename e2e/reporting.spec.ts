import { test, expect, type PackmanPage } from "./fixtures";
import type { ScheduledRunsResponse } from "../src/bindings";

const BACKEND = "/usr/libexec/cockpit-pacman/cockpit-pacman-backend";
const UNIT = "cockpit-pacman-scheduled.service";
const DROP_IN = "/run/systemd/system/cockpit-pacman-scheduled.service.d/90-e2e-reporting.conf";
const TIMER = "cockpit-pacman-scheduled.timer";
const TIMER_DROP_IN = "/run/systemd/system/cockpit-pacman-scheduled.timer.d/zz-e2e-reporting.conf";

async function command(pacman: PackmanPage, args: string[], privileged = true): Promise<string> {
  return pacman.frame.locator("body").evaluate(async (_body, input) => {
    const cockpit = Reflect.get(globalThis, "cockpit") as {
      spawn(args: string[], options: { superuser?: "require"; err: "message" }): Promise<string>;
    };
    return await cockpit.spawn(input.args, { err: "message", ...(input.privileged ? { superuser: "require" as const } : {}) });
  }, { args, privileged });
}

async function journalCursor(pacman: PackmanPage): Promise<string> {
  const output = await command(pacman, ["journalctl", "--show-cursor", "-n", "0", "--no-pager"]);
  const cursor = output.split("\n").find((line) => line.startsWith("-- cursor: "))?.slice(11);
  if (!cursor) throw new Error("The guest journal must expose a cursor for diagnostic checks");
  return cursor;
}

async function journalSince(pacman: PackmanPage, cursor: string): Promise<number[]> {
  await command(pacman, ["journalctl", "--sync"]);
  const output = await command(pacman, ["journalctl", "-t", "cockpit-pacman", "--after-cursor", cursor, "--no-pager", "--output=json", "--output-fields=PRIORITY"]);
  return output.split("\n").filter(Boolean).map(line => {
    const entry: { PRIORITY: string } = JSON.parse(line);
    return Number(entry.PRIORITY);
  });
}

async function history(pacman: PackmanPage): Promise<ScheduledRunsResponse> {
  return JSON.parse(await command(pacman, [BACKEND, "list-scheduled-runs", "0", "10"], false));
}

// These tests change systemd's last invocation, which only a VM rollback restores.
test.describe("configuration and scheduled reporting faults", () => {
  test.skip(process.env.COCKPIT_FAULT_TESTS !== "1", "requires a disposable VM snapshot");
  let backup: string | undefined;

  test.beforeEach(async ({ pacman }) => {
    await pacman.navigateToPlugin();
    backup = undefined;
    backup = (await command(pacman, ["sh", "-ceu", `
      state=$(systemctl show -p ActiveState --value ${UNIT})
      case "$state" in inactive|failed) ;; *) echo "scheduled service is already running" >&2; exit 1;; esac
      test ! -e ${DROP_IN}
      test ! -e ${TIMER_DROP_IN}
      if mountpoint -q /var/log/cockpit-pacman; then echo "log directory is already a mount point" >&2; exit 1; fi
      work=$(mktemp -d /run/cockpit-pacman-reporting.XXXXXX)
      for item in /etc/cockpit-pacman/config.json /var/log/cockpit-pacman/scheduled.jsonl; do
        if test -e "$item"; then cp -p "$item" "$work/$(basename "$item")"; fi
      done
      if systemctl is-active --quiet cockpit-pacman-scheduled.timer; then touch "$work/timer-active"; fi
      systemctl stop cockpit-pacman-scheduled.timer
      install -d /etc/cockpit-pacman /var/log/cockpit-pacman
      printf '%s\\n' "$work"
    `])).trim();
  });

  test.afterEach(async ({ pacman }) => {
    if (!backup) return;
    await command(pacman, ["sh", "-ceu", `
      if test -e ${TIMER_DROP_IN}; then systemctl stop ${TIMER}; fi
      if test -e ${DROP_IN}; then
        systemctl kill --signal=KILL --kill-whom=all ${UNIT} 2>/dev/null || true
        systemctl stop --no-block ${UNIT} || true
      fi
      for attempt in $(seq 1 100); do
        state=$(systemctl show -p ActiveState --value ${UNIT})
        case "$state" in inactive|failed) break;; esac
        if test -e ${DROP_IN}; then systemctl kill --signal=KILL --kill-whom=all ${UNIT} 2>/dev/null || true; fi
        sleep .1
      done
      if mountpoint -q /var/log/cockpit-pacman; then umount /var/log/cockpit-pacman; fi
      rm -f ${DROP_IN}
      rm -f ${TIMER_DROP_IN}
      for item in /etc/cockpit-pacman/config.json /var/log/cockpit-pacman/scheduled.jsonl; do
        saved="$1/$(basename "$item")"
        if test -e "$saved"; then cp -p "$saved" "$item"; else rm -f "$item"; fi
      done
      systemctl daemon-reload
      systemctl reset-failed ${UNIT} || true
      if test -e "$1/timer-active"; then systemctl start cockpit-pacman-scheduled.timer; fi
      rm -rf "$1"
    `, "restore-reporting-fixture", backup]);
  });

  test("reports unreadable settings and ignores without replacing saved values", async ({ pacman }) => {
    await command(pacman, ["sh", "-ceu", `
      printf '%s\\n' '{"security_advisories":false,"ignored_packages":["htop"],"schedule":{"enabled":false,"mode":"check","schedule":"daily","max_packages":5}}' > /etc/cockpit-pacman/config.json
      chmod 000 /etc/cockpit-pacman/config.json
    `]);
    expect(JSON.parse(await command(pacman, [BACKEND, "get-settings"], false)).security_advisories).toBeNull();
    expect(JSON.parse(await command(pacman, [BACKEND, "list-ignored"], false)).packages).toBeNull();
    expect(JSON.parse(await command(pacman, [BACKEND, "check-security"], false)).code).toBe("permission_denied");
    await pacman.page.reload();
    await expect(pacman.panel.getByRole("heading", { name: /Security status unavailable/ })).toBeVisible();
    await pacman.frame.getByRole("button", { name: "Overview settings", exact: true }).click();
    const unavailableSetting = pacman.frame.getByRole("menuitem", { name: /Check security advisories/ });
    await expect(unavailableSetting).toBeDisabled();
    await expect(unavailableSetting).toContainText("Saved advisory setting is unavailable");
    await expect(pacman.frame.getByRole("checkbox", { name: /Check security advisories/ })).toHaveCount(0);
    await pacman.frame.getByRole("button", { name: "Overview settings", exact: true }).click();
    await pacman.frame.getByRole("button", { name: /Manage Ignored/i }).click();
    const modal = pacman.frame.getByRole("dialog", { name: "Ignored Packages" });
    await expect(modal.getByText("Saved package ignores are unavailable")).toBeVisible();
    await expect(modal.getByText("No ignored packages", { exact: true })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Ignore Package", exact: true })).toBeDisabled();
    await command(pacman, ["chmod", "644", "/etc/cockpit-pacman/config.json"]);
    await modal.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(modal.getByRole("button", { name: "Unignore htop", exact: true })).toBeVisible();
    expect(JSON.parse(await command(pacman, [BACKEND, "get-settings"], false)).security_advisories).toBe(false);
    await modal.getByRole("button", { name: "Close", exact: true }).last().click();
    await pacman.page.reload();
    await pacman.frame.getByRole("button", { name: "Overview settings", exact: true }).click();
    const toggle = pacman.frame.getByRole("checkbox", { name: /Check security advisories/ });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect.poll(async () => JSON.parse(await command(pacman, [BACKEND, "get-settings"], false)).security_advisories).toBe(true);
    await expect(toggle).toBeEnabled({ timeout: 30000 });
    await toggle.click();
    await expect.poll(async () => JSON.parse(await command(pacman, [BACKEND, "get-settings"], false)).security_advisories).toBe(false);
    await pacman.page.reload();
    await pacman.frame.getByRole("button", { name: "Overview settings", exact: true }).click();
    await expect(toggle).not.toBeChecked();
  });

  test("reports an interrupted run with an unknown mode when config parsing fails", async ({ pacman }) => {
    const cursor = await journalCursor(pacman);
    await command(pacman, ["sh", "-ceu", "printf invalid > /etc/cockpit-pacman/config.json; chmod 644 /etc/cockpit-pacman/config.json"]);
    await command(pacman, ["env", "SERVICE_RESULT=signal", BACKEND, "scheduled-record-interrupted"]);
    const response = await history(pacman);
    expect(response.runs[0].mode).toBe("unknown");
    expect(response.runs[0].details.join(" ")).toContain("Could not read the scheduled mode");
    expect((await journalSince(pacman, cursor)).filter(priority => priority === 4).length).toBeGreaterThan(0);
  });

  test("uses independent evidence when the service and its record writer are killed", async ({ pacman }) => {
    if (!backup) throw new Error("Reporting fixture was not prepared");
    const fixtureDirectory = backup;
    await command(pacman, ["sh", "-ceu", `
      install -d /run/systemd/system/${UNIT}.d
      cat > "$1/record-after-wait" <<'WRITER'
#!/bin/sh
: > "$0.ready"
sleep 120
exec ${BACKEND} scheduled-record-interrupted
WRITER
      chmod 755 "$1/record-after-wait"
      printf '%s\\n' '[Service]' 'ExecStart=' 'ExecStart=/usr/bin/sleep 120' 'ExecStopPost=' "ExecStopPost=$1/record-after-wait" > ${DROP_IN}
      rm -f /var/log/cockpit-pacman/scheduled.jsonl
      systemctl daemon-reload
      systemctl start --no-block ${UNIT}
    `, "prepare-writer", fixtureDirectory]);
    await expect.poll(() => command(pacman, ["systemctl", "show", "-p", "SubState", "--value", UNIT]).then((value) => value.trim()))
      .toBe("start");
    await command(pacman, ["systemctl", "kill", "--signal=KILL", "--kill-whom=main", UNIT]);
    await expect.poll(() => command(pacman, ["sh", "-ceu", 'if test -e "$1/record-after-wait.ready"; then printf ready; fi', "writer-state", fixtureDirectory]))
      .toBe("ready");
    await expect.poll(() => command(pacman, ["systemctl", "show", "-p", "SubState", "--value", UNIT]).then((value) => value.trim()))
      .toBe("stop-post");
    await command(pacman, ["systemctl", "kill", "--signal=KILL", "--kill-whom=all", UNIT]);
    await expect.poll(async () => (await history(pacman)).runs[0]?.status).toBe("failed");
    expect(await command(pacman, ["sh", "-ceu", "test ! -s /var/log/cockpit-pacman/scheduled.jsonl && printf missing"])).toBe("missing");
    const latest = (await history(pacman)).runs[0];
    expect(latest.mode).toBe("unknown");
    expect(latest.packages_upgraded).toBeNull();
    expect(latest.error).toContain("without a run record");
    await command(pacman, ["sh", "-ceu", "touch /var/log/cockpit-pacman/scheduled.jsonl; chmod 000 /var/log/cockpit-pacman/scheduled.jsonl"]);
    const unreadable = await history(pacman);
    expect(unreadable.warning).toContain("could not be read");
    expect(unreadable.runs[0].invocation_id).toBe(latest.invocation_id);
    await pacman.page.reload();
    await expect(pacman.panel.getByRole("heading", { name: /Last scheduled upgrade failed/ })).toBeVisible();
  });

  test("reports unavailable results after a completed run on a full log filesystem", async ({ pacman }) => {
    const cursor = await journalCursor(pacman);
    await command(pacman, ["sh", "-ceu", `
      printf '%s\\n' '{"schedule":{"enabled":true,"mode":"check","schedule":"daily","max_packages":5}}' > /etc/cockpit-pacman/config.json
      chmod 644 /etc/cockpit-pacman/config.json
      mount -t tmpfs -o size=64k,mode=755 cockpit-pacman-reporting /var/log/cockpit-pacman
      dd if=/dev/zero of=/var/log/cockpit-pacman/full bs=4096 count=32 status=none 2>/dev/null || true
      test "$(stat -f -c %a /var/log/cockpit-pacman)" -eq 0
      install -d /run/systemd/system/${TIMER}.d
      printf '%s\\n' '[Timer]' 'OnCalendar=' 'OnCalendar=2099-01-01 00:00:00 UTC' 'Persistent=false' 'RandomizedDelaySec=0' > ${TIMER_DROP_IN}
      systemctl daemon-reload
      systemctl start ${TIMER}
      systemctl is-active --quiet ${TIMER}
      systemctl reset-failed ${UNIT} || true
      systemctl start ${UNIT}
    `]);
    const latest = (await history(pacman)).runs[0];
    expect(latest.status).toBe("unrecorded");
    expect(latest.success).toBe(true);
    expect(latest.packages_checked).toBeNull();
    await pacman.page.reload();
    await expect(pacman.panel.getByRole("heading", { name: /Scheduled run record unavailable/ })).toBeVisible();
    expect((await journalSince(pacman, cursor)).filter(priority => priority === 4).length).toBeGreaterThan(0);
  });
  test("journals a failed background news refresh while showing the cached item", async ({ pacman }) => {
    const cursor = await journalCursor(pacman);
    const newsBackup = (await command(pacman, ["sh", "-ceu", `
      work=$(mktemp -d)
      path="$HOME/.config/cockpit-pacman/news-cache.json"
      if test -e "$path"; then cp -p "$path" "$work/news-cache.json"; fi
      mkdir -p "$HOME/.config/cockpit-pacman"
      printf '%s' '{"items":[{"title":"Reporting fixture news","link":"https://example.invalid/reporting-fixture","published":"'"$(date --iso-8601=seconds)"'","summary":"Cached fixture"}],"stale":false}' > "$path"
      printf '%s' "$work"
    `], false)).trim();
    let wrapped = false;
    try {
      await command(pacman, ["sh", "-ceu", `
        test ! -e ${BACKEND}.reporting-original
        cp -p ${BACKEND} ${BACKEND}.reporting-original
        cat > ${BACKEND}.reporting-wrapper <<'WRAPPER'
#!/bin/sh
if [ "$1" = fetch-news ]; then
  exec sudo -n unshare --net -- runuser -u "$(id -un)" -- ${BACKEND}.reporting-original "$@"
fi
exec ${BACKEND}.reporting-original "$@"
WRAPPER
        chmod 755 ${BACKEND}.reporting-wrapper
        mv ${BACKEND}.reporting-wrapper ${BACKEND}
      `]);
      wrapped = true;
      await pacman.page.reload();
      await expect(pacman.panel.getByRole("heading", { name: /Showing cached news/ })).toBeVisible({ timeout: 30000 });
      await expect(pacman.panel.getByRole("heading", { name: /Reporting fixture news/ })).toBeVisible();
      expect((await journalSince(pacman, cursor)).filter(priority => priority === 4).length).toBeGreaterThan(0);
    } finally {
      if (wrapped) await command(pacman, ["mv", `${BACKEND}.reporting-original`, BACKEND]);
      await command(pacman, ["sh", "-ceu", `
        path="$HOME/.config/cockpit-pacman/news-cache.json"
        if test -e "$1/news-cache.json"; then cp -p "$1/news-cache.json" "$path"; else rm -f "$path"; fi
        rm -rf "$1"
      `, "restore-news", newsBackup], false);
    }
  });

});
