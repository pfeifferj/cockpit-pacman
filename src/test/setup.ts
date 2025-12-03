import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Mock cockpit global
const mockSpawn = vi.fn();

const cockpitMock = {
  spawn: mockSpawn,
};

vi.stubGlobal("cockpit", cockpitMock);

export { mockSpawn };
