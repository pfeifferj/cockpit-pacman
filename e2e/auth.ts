import { test as base, expect, type Page } from "@playwright/test";

export const test = base.extend<{ credentialCaptureGuard: void }>({
  credentialCaptureGuard: [async ({ trace, video }, use) => {
    const traceMode = typeof trace === "string" ? trace : trace.mode;
    const videoMode = typeof video === "string" ? video : video.mode;
    if (traceMode !== "off" || videoMode !== "off" || process.env.DEBUG || process.env.PWDEBUG) {
      throw new Error("Cockpit authentication requires trace, video and debug logging to be disabled");
    }
    await use();
  }, { auto: true }],
});

export async function submitPassword(page: Page, input: string, button: string, password: string) {
  await page.locator(input).waitFor({ state: "visible" });
  await expect(page.locator(button)).toBeEnabled();
  // Clearing in the same browser task prevents timeout snapshots retaining the secret.
  await page.evaluate(({ input, button, password }) => {
    const field = document.querySelector<HTMLInputElement>(input);
    const submit = document.querySelector<HTMLButtonElement>(button);
    if (!field || !submit) throw new Error("Authentication form unavailable");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Authentication input unavailable");
    const setValue = (value: string) => {
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    try {
      setValue(password);
      submit.click();
    } finally {
      setValue("");
    }
  }, { input, button, password });
}

export async function authenticate(page: Page, administrative = true) {
  const username = process.env.COCKPIT_USER;
  const password = process.env.COCKPIT_PASSWORD;
  if (!username || !password) {
    throw new Error("COCKPIT_USER and COCKPIT_PASSWORD environment variables are required");
  }

  let stage = "loading Cockpit";
  try {
    await page.goto("/");
    stage = "logging in";
    await expect.poll(async () =>
      await page.locator("#login-user-input").isVisible() || await page.locator("#nav-system").isVisible(),
    { timeout: 30000 }).toBe(true);
    if (await page.locator("#login-user-input").isVisible()) {
      await page.locator("#login-user-input").fill(username);
      await submitPassword(page, "#login-password-input", "#login-button", password);
    }
    await page.locator("#nav-system").waitFor({ timeout: 30000 });
    if (!administrative) return;

    const indicator = page.locator("#super-user-indicator");
    await indicator.waitFor({ timeout: 30000 });
    if ((await indicator.innerText()).includes("Administrative")) return;

    stage = "requesting administrative access";
    await indicator.click();
    const dialog = page.getByRole("dialog");
    const prompt = dialog.locator('input[type="password"]');
    await expect(prompt.or(indicator.filter({ hasText: "Administrative" })).first())
      .toBeVisible({ timeout: 15000 });
    if (await prompt.isVisible()) {
      const submit = dialog.getByRole("button", { name: "Authenticate", exact: true });
      await submit.evaluate((button) => button.setAttribute("data-auth-submit", ""));
      await submitPassword(page, '[role="dialog"] input[type="password"]', "[data-auth-submit]", password);
    }
    stage = "confirming administrative access";
    await expect(indicator).toContainText("Administrative", { timeout: 15000 });
    stage = "closing the administrative access notice";
    await dialog.getByRole("button", { name: "Close", exact: true }).evaluateAll(buttons => {
      const close = buttons.find(button => button.getClientRects().length > 0);
      if (close instanceof HTMLButtonElement) close.click();
    });
  } catch {
    await page.close().catch(() => {});
    throw new Error(`Cockpit authentication failed while ${stage}`);
  }
}
