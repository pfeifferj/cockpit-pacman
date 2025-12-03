declare module "cockpit" {
  interface SpawnOptions {
    superuser?: "try" | "require";
    err?: "out" | "message";
    environ?: string[];
    directory?: string;
    binary?: boolean;
  }

  interface SpawnProcess extends Promise<string> {
    stream(callback: (data: string) => void): void;
    input(data: string, stream?: boolean): void;
    close(problem?: string): void;
  }

  function spawn(args: string[], options?: SpawnOptions): SpawnProcess;
}

declare const cockpit: typeof import("cockpit");
