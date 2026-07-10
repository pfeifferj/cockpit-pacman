import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorAlert } from "./ErrorAlert";

describe("ErrorAlert", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders details under the message when present", () => {
    render(
      <ErrorAlert
        error="Preflight failed"
        title="Error"
        details="caused by: could not resolve host mirror.example"
      />
    );
    expect(screen.getByText("Preflight failed")).toBeInTheDocument();
    expect(
      screen.getByText(/could not resolve host mirror.example/)
    ).toBeInTheDocument();
  });

  it("hides details when the database is locked", () => {
    render(
      <ErrorAlert
        error="failed to initialize transaction (unable to lock database)"
        code="database_locked"
        title="Error"
        details="internal context chain"
        lockMessage="Database is busy, try again shortly."
      />
    );
    expect(
      screen.getByText("Database is busy, try again shortly.")
    ).toBeInTheDocument();
    expect(screen.queryByText("internal context chain")).not.toBeInTheDocument();
  });
});
