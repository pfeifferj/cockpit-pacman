import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

// Mock ResizeObserver for jsdom
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// Mock localStorage for jsdom (unavailable with opaque origins)
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();
vi.stubGlobal("localStorage", localStorageMock);
Object.defineProperty(window, "localStorage", { value: localStorageMock });

// Mock cockpit global
const mockSpawn = vi.fn();
const mockTransportControl = vi.fn();

const mockPermission = vi.fn(() => ({
  allowed: true as boolean | null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  close: vi.fn(),
}));

// cockpit.location: go/replace update the location and fire "locationchanged"
// synchronously; setMockLocation stands in for browser Back/Forward or a typed URL.
type MockOptions = Record<string, string | string[]>;
let locationPath: string[] = [];
let locationOptions: MockOptions = {};
const locationListeners = new Set<() => void>();

function encodeLocation(path: string[], options: MockOptions): string {
  const query = Object.entries(options)
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}=${encodeURIComponent(v)}`))
    .join("&");
  return "/" + path.map(encodeURIComponent).join("/") + (query ? `?${query}` : "");
}

function parsePath(path: string | string[], options: MockOptions = {}): [string[], MockOptions] {
  if (Array.isArray(path)) return [[...path], { ...options }];
  const [pathPart, query = ""] = path.split("?");
  const parsed: MockOptions = {};
  for (const pair of query.split("&").filter(Boolean)) {
    const [key, value = ""] = pair.split("=");
    parsed[key] = decodeURIComponent(value);
  }
  return [pathPart.split("/").filter(Boolean), { ...parsed, ...options }];
}

function setMockLocation(path: string | string[], options?: MockOptions): void {
  [locationPath, locationOptions] = parsePath(path, options);
  for (const listener of [...locationListeners]) listener();
}

const mockLocationGo = vi.fn((path: string | string[], options?: MockOptions) => setMockLocation(path, options));
const mockLocationReplace = vi.fn((path: string | string[], options?: MockOptions) => setMockLocation(path, options));

/** Set the location before render without notifying anyone. */
function resetMockLocation(path: string | string[] = [], options?: MockOptions): void {
  [locationPath, locationOptions] = parsePath(path, options);
  mockLocationGo.mockClear();
  mockLocationReplace.mockClear();
}

beforeEach(() => resetMockLocation());

const cockpitMock = {
  get location() {
    return {
      href: encodeLocation(locationPath, locationOptions),
      path: [...locationPath],
      options: { ...locationOptions },
      go: mockLocationGo,
      replace: mockLocationReplace,
      encode: (path: string | string[], options?: MockOptions) => encodeLocation(...parsePath(path, options)),
      decode: (href: string) => parsePath(href)[0],
    };
  },
  addEventListener: (_event: string, handler: () => void) => locationListeners.add(handler),
  removeEventListener: (_event: string, handler: () => void) => locationListeners.delete(handler),
  spawn: mockSpawn,
  permission: mockPermission,
  transport: {
    control: mockTransportControl,
  },
};

vi.stubGlobal("cockpit", cockpitMock);

export {
  mockSpawn,
  mockTransportControl,
  mockPermission,
  mockLocationGo,
  mockLocationReplace,
  setMockLocation,
  resetMockLocation,
};
