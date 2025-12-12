import "@patternfly/patternfly/patternfly.css";
import "@patternfly/patternfly/patternfly-addons.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";

function applyTheme() {
  const html = document.documentElement;

  // Check Cockpit's theme setting, or fall back to system preference
  const cockpitTheme = html.getAttribute("theme");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = cockpitTheme === "dark" || (cockpitTheme !== "light" && systemDark);

  if (isDark) {
    html.classList.add("pf-v6-theme-dark");
  } else {
    html.classList.remove("pf-v6-theme-dark");
  }
}

applyTheme();

// Watch for Cockpit theme changes
new MutationObserver(() => applyTheme())
  .observe(document.documentElement, { attributes: true, attributeFilter: ["theme"] });

// Watch for system theme changes
window.matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", applyTheme);

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
