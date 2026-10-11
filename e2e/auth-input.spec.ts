import { expect } from "@playwright/test";
import { buildSync } from "esbuild";
import { test, submitPassword } from "./auth";

test.use({ storageState: { cookies: [], origins: [] } });

test("password submission updates and clears controlled inputs", async ({ page }) => {
  const script = buildSync({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        function Form() {
          const [password, setPassword] = useState("");
          const [submitted, setSubmitted] = useState("");
          const [redraw, setRedraw] = useState(0);
          return <>
            <input id="password" type="password" value={password}
              onChange={event => setPassword(event.target.value)} />
            <button id="submit" onClick={() => setSubmitted(password)}>Submit</button>
            <button id="redraw" onClick={() => setRedraw(redraw + 1)}>Redraw</button>
            <output>{submitted}</output>
          </>;
        }
        createRoot(document.getElementById("root")).render(<Form />);
      `,
      loader: "jsx",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  }).outputFiles[0].text;
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });

  await submitPassword(page, "#password", "#submit", "controlled-input-test");
  await expect(page.locator("output")).toHaveText("controlled-input-test");
  await expect(page.locator("#password")).toHaveValue("");
  await page.locator("#redraw").click();
  await expect(page.locator("#password")).toHaveValue("");
});
