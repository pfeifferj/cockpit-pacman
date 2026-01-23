import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Mock ResizeObserver for jsdom
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// Mock cockpit global
const mockSpawn = vi.fn();

const cockpitMock = {
  spawn: mockSpawn,
};

vi.stubGlobal("cockpit", cockpitMock);

export { mockSpawn };
