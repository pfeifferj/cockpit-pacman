import { test as setup, authenticate } from "./auth";
import * as fs from "fs";
import * as path from "path";

const authDir = path.join(process.cwd(), ".auth");
const authFile = path.join(authDir, "session.json");

setup("authenticate with cockpit", async ({ page }) => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  }
  await authenticate(page, false);
  await page.context().storageState({ path: authFile });
  fs.chmodSync(authFile, 0o600);
});
