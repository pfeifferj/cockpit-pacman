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

interface CockpitUserInfo {
  id: number;
  gid: number;
  name: string;
  full: string;
  groups: string[];
  home: string;
  shell: string;
}

interface CockpitFileHandle {
  read(): Promise<string | null>;
  replace(content: string): Promise<void>;
  modify(callback: (content: string | null) => string): Promise<void>;
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
      bus?: "session" | "system" | "none";
      address?: string;
      superuser?: "try" | "require";
    },
  ): CockpitDBusClient;
  file(
    path: string,
    options?: { syntax?: unknown; superuser?: "try" | "require" },
  ): CockpitFileHandle;
  variant(type: string, value: unknown): { t: string; v: unknown };
  user(): Promise<CockpitUserInfo>;
};
