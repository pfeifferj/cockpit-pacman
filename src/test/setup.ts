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
const mockTransportControl = vi.fn();

const cockpitMock = {
  spawn: mockSpawn,
  transport: {
    control: mockTransportControl,
  },
};

vi.stubGlobal("cockpit", cockpitMock);

export { mockSpawn, mockTransportControl };
