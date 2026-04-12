import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

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

const mockFile = vi.fn(() => ({
  read: vi.fn(() => Promise.resolve(null)),
  replace: vi.fn(() => Promise.resolve()),
  modify: vi.fn(() => Promise.resolve()),
}));

const cockpitMock = {
  spawn: mockSpawn,
  file: mockFile,
  dbus: vi.fn(() => ({
    call: vi.fn(() => Promise.resolve([])),
    close: vi.fn(),
  })),
  variant: vi.fn((t: string, v: unknown) => ({ t, v })),
};

vi.stubGlobal("cockpit", cockpitMock);

export { mockSpawn, mockFile };
