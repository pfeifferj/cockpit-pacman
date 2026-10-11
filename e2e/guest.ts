import type { FrameLocator } from "@playwright/test";

export const BACKEND = "/usr/libexec/cockpit-pacman/cockpit-pacman-backend";
export const FIXTURE = "/usr/local/libexec/cockpit-pacman-e2e/fixture.py";

export async function guestCommand(frame: FrameLocator, args: string[], administrative = true): Promise<string> {
  return frame.locator("body").evaluate(async (_body, { args, administrative }) => {
    const cockpit = Reflect.get(globalThis, "cockpit") as {
      spawn(args: string[], options: { superuser?: "require"; err: "message" }): Promise<string>;
    };
    try {
      return await cockpit.spawn(args, administrative ? { superuser: "require", err: "message" } : { err: "message" });
    } catch (error) {
      throw new Error(error && typeof error === "object" && "message" in error ? String(error.message) : String(error));
    }
  }, { args, administrative });
}
