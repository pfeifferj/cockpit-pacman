import type { KeyringCredentials } from "./api";

const SERVICE_NAME = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";
const SERVICE_IFACE = "org.freedesktop.Secret.Service";
const ITEM_IFACE = "org.freedesktop.Secret.Item";
const PROPS_IFACE = "org.freedesktop.DBus.Properties";
const SESSION_IFACE = "org.freedesktop.Secret.Session";

const LOOKUP_ATTRS = { service: "cockpit-pacman", type: "archweb" };

export async function getCredentials(): Promise<KeyringCredentials> {
  const client = cockpit.dbus(SERVICE_NAME, { bus: "session" });
  try {
    const [, sessionPath] = (await client.call(
      SERVICE_PATH,
      SERVICE_IFACE,
      "OpenSession",
      ["plain", cockpit.variant("s", "")],
    )) as [unknown, string];

    const [unlocked, locked] = (await client.call(
      SERVICE_PATH,
      SERVICE_IFACE,
      "SearchItems",
      [LOOKUP_ATTRS],
    )) as [string[], string[]];

    let itemPaths = unlocked;

    if (itemPaths.length === 0 && locked.length > 0) {
      const [unlockedPaths, promptPath] = (await client.call(
        SERVICE_PATH,
        SERVICE_IFACE,
        "Unlock",
        [locked],
      )) as [string[], string];

      if (promptPath !== "/") {
        throw new Error("Keyring requires interactive unlock");
      }
      itemPaths = unlockedPaths;
    }

    if (itemPaths.length === 0) {
      throw new Error("No ArchWeb credentials found in keyring");
    }

    const itemPath = itemPaths[0];

    const attrsResult = (await client.call(
      itemPath,
      PROPS_IFACE,
      "Get",
      [ITEM_IFACE, "Attributes"],
    )) as [{ v: Record<string, string> }];
    const attrs = attrsResult[0].v;
    const username = attrs.username;
    if (!username) {
      throw new Error("Keyring item missing 'username' attribute");
    }

    const [secrets] = (await client.call(
      SERVICE_PATH,
      SERVICE_IFACE,
      "GetSecrets",
      [[itemPath], sessionPath],
    )) as [Record<string, [string, string, string, string]>];

    const secretTuple = secrets[itemPath];
    if (!secretTuple) {
      throw new Error("Failed to retrieve secret from keyring");
    }

    const passwordBytes = secretTuple[2];
    const password = new TextDecoder().decode(
      Uint8Array.from(atob(passwordBytes), (c) => c.charCodeAt(0)),
    );

    await client
      .call(sessionPath, SESSION_IFACE, "Close", null)
      .catch(() => {});

    return { username, password };
  } finally {
    client.close();
  }
}
