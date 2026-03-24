interface CockpitProcess extends Promise<string> {
  input(data: string, stream?: boolean): void;
  stream(callback: (data: string) => void): void;
  close(problem?: string): void;
}

interface CockpitDBusClient {
  call(
    path: string,
    iface: string,
    method: string,
    args: unknown[] | null,
    options?: { type?: string },
  ): Promise<unknown[]>;
  close(): void;
}

declare const cockpit: {
  spawn(
    args: string[],
    options?: {
      superuser?: "try" | "require";
      err?: "out" | "message";
    },
  ): CockpitProcess;
  dbus(
    name: string,
    options?: {
      bus?: "session" | "system";
      superuser?: "try" | "require";
    },
  ): CockpitDBusClient;
  variant(type: string, value: unknown): { t: string; v: unknown };
};
