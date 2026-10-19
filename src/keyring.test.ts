import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getCredentials, CredentialError } from "./keyring";

type Call = (path: string, iface: string, method: string, args: unknown[] | null) => Promise<unknown[]>;

const ITEM = "/org/freedesktop/secrets/collection/login/1";
const SESSION = "/org/freedesktop/secrets/session/1";

interface Setup {
  unlocked?: string[];
  locked?: string[];
  prompt?: string;
  attrs?: Record<string, string>;
  secrets?: Record<string, [string, string, string, string]>;
  openSession?: () => Promise<unknown[]>;
}

function mockBus(setup: Setup) {
  const call = vi.fn<Call>(async (_path, iface, method) => {
    if (method === "OpenSession") return setup.openSession ? setup.openSession() : [null, SESSION];
    if (method === "SearchItems") return [setup.unlocked ?? [], setup.locked ?? []];
    if (method === "Unlock") return [setup.locked ?? [], setup.prompt ?? "/"];
    if (method === "Get") return [{ v: setup.attrs ?? { username: "alice" } }];
    if (method === "GetSecrets") {
      return [setup.secrets ?? { [ITEM]: [SESSION, "", btoa("secret"), "text/plain"] }];
    }
    if (iface === "org.freedesktop.Secret.Session") return [];
    throw new Error(`unexpected ${method}`);
  });
  vi.stubGlobal("cockpit", {
    ...(globalThis as unknown as { cockpit: object }).cockpit,
    user: vi.fn().mockResolvedValue({ id: 1000 }),
    variant: (t: string, v: unknown) => ({ t, v }),
    dbus: vi.fn(() => ({ call, close: vi.fn() })),
  });
  return call;
}

async function reasonOf(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CredentialError);
  return (err as CredentialError).reason;
}

describe("getCredentials", () => {
  const original = (globalThis as unknown as { cockpit: object }).cockpit;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.stubGlobal("cockpit", original));

  it("returns the username and decoded secret", async () => {
    mockBus({ unlocked: [ITEM] });
    await expect(getCredentials()).resolves.toEqual({ username: "alice", password: "secret" });
  });

  it("decodes a UTF-8 password", async () => {
    const password = "café雪";
    const bytes = new TextEncoder().encode(password);
    mockBus({ unlocked: [ITEM], secrets: { [ITEM]: [SESSION, "", btoa(String.fromCharCode(...bytes)), "text/plain"] } });
    await expect(getCredentials()).resolves.toEqual({ username: "alice", password });
  });

  it("reports absent when no item matches", async () => {
    mockBus({});
    expect(await reasonOf(getCredentials())).toBe("absent");
  });

  it("reports absent when the Secret Service is not on the bus", async () => {
    mockBus({
      openSession: () => Promise.reject({
        name: "org.freedesktop.DBus.Error.ServiceUnknown",
        message: "The name org.freedesktop.secrets was not provided",
      }),
    });
    expect(await reasonOf(getCredentials())).toBe("absent");
  });

  it("reports absent when the session bus connection fails", async () => {
    mockBus({ openSession: () => Promise.reject({ problem: "not-found", message: "" }) });
    expect(await reasonOf(getCredentials())).toBe("absent");
  });

  it("reports failed when the bus call times out", async () => {
    mockBus({ openSession: () => Promise.reject({ problem: "timeout", message: "" }) });
    expect(await reasonOf(getCredentials())).toBe("failed");
  });

  it("reports failed when bus access is denied", async () => {
    mockBus({ openSession: () => Promise.reject({ problem: "access-denied", message: "" }) });
    expect(await reasonOf(getCredentials())).toBe("failed");
  });

  it("reports locked when unlocking needs a prompt", async () => {
    mockBus({ locked: [ITEM], prompt: "/org/freedesktop/secrets/prompt/u1" });
    expect(await reasonOf(getCredentials())).toBe("locked");
  });

  it("reports malformed when the item has no username", async () => {
    mockBus({ unlocked: [ITEM], attrs: {} });
    expect(await reasonOf(getCredentials())).toBe("malformed");
  });

  it("reports malformed when the secret is missing", async () => {
    mockBus({ unlocked: [ITEM], secrets: {} });
    expect(await reasonOf(getCredentials())).toBe("malformed");
  });

  it("reports failed for other D-Bus errors", async () => {
    mockBus({
      openSession: () => Promise.reject({ name: "org.freedesktop.DBus.Error.AccessDenied", message: "denied" }),
    });
    expect(await reasonOf(getCredentials())).toBe("failed");
  });
});
