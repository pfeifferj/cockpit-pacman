import type { KeyringCredentials } from "./api";

const SERVICE_NAME = "org.freedesktop.secrets";
const SERVICE_PATH = "/org/freedesktop/secrets";
const SERVICE_IFACE = "org.freedesktop.Secret.Service";
const ITEM_IFACE = "org.freedesktop.Secret.Item";
const PROPS_IFACE = "org.freedesktop.DBus.Properties";
const SESSION_IFACE = "org.freedesktop.Secret.Session";

const LOOKUP_ATTRS = { service: "cockpit-pacman", type: "archweb" };

const SERVICE_ABSENT_ERRORS = new Set([
  "org.freedesktop.DBus.Error.ServiceUnknown",
  "org.freedesktop.DBus.Error.NameHasNoOwner",
]);

// cockpit.dbus problem codes meaning the session bus itself is unreachable.
const BUS_ABSENT_PROBLEMS = new Set(["not-found", "disconnected"]);

/**
 * absent: no ArchWeb item, or no Secret Service on the session bus.
 * locked: unlocking needs an interactive prompt.
 * malformed: the item lacks a username or a secret.
 * failed: anything else.
 */
export type CredentialErrorReason = "absent" | "locked" | "malformed" | "failed";

export class CredentialError extends Error {
  reason: CredentialErrorReason;

  constructor(reason: CredentialErrorReason, message: string) {
    super(message);
    this.name = "CredentialError";
    this.reason = reason;
  }
}

function classify(err: unknown): CredentialError {
  if (err instanceof CredentialError) return err;
  const e = (err ?? {}) as { name?: unknown; message?: unknown; problem?: unknown };
  const message = typeof e.message === "string" && e.message
    ? e.message
    : typeof e.problem === "string" ? e.problem : String(err);
  if (typeof e.name === "string" && SERVICE_ABSENT_ERRORS.has(e.name)) {
    return new CredentialError("absent", message);
  }
  // cockpit.dbus reports a failed bus connection as a problem code with no D-Bus error name.
  if (typeof e.problem === "string" && typeof e.name !== "string" && BUS_ABSENT_PROBLEMS.has(e.problem)) {
    return new CredentialError("absent", message);
  }
  return new CredentialError("failed", message);
}

export async function getCredentials(): Promise<KeyringCredentials> {
  try {
    return await readCredentials();
  } catch (err) {
    throw classify(err);
  }
}

async function readCredentials(): Promise<KeyringCredentials> {
  const info = await cockpit.user();
  const uid = info.id;
  const client = cockpit.dbus(SERVICE_NAME, {
    bus: "none",
    address: `unix:path=/run/user/${uid}/bus`,
  });
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
        throw new CredentialError("locked", "Keyring requires interactive unlock");
      }
      itemPaths = unlockedPaths;
    }

    if (itemPaths.length === 0) {
      throw new CredentialError("absent", "No ArchWeb credentials found in keyring");
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
      throw new CredentialError("malformed", "Keyring item missing 'username' attribute");
    }

    const [secrets] = (await client.call(
      SERVICE_PATH,
      SERVICE_IFACE,
      "GetSecrets",
      [[itemPath], sessionPath],
    )) as [Record<string, [string, string, string, string]>];

    const secretTuple = secrets[itemPath];
    if (!secretTuple) {
      throw new CredentialError("malformed", "Failed to retrieve secret from keyring");
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
