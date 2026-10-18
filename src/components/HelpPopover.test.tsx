import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Table, Thead, Tbody, Tr, Th, Td } from "@patternfly/react-table";
import { HelpPopover, helpInfo } from "./HelpPopover";

describe("HelpPopover", () => {
  it("names the trigger after its label", () => {
    render(<HelpPopover label="cache size" body="Body text" />);
    expect(screen.getByRole("button", { name: "More information about cache size" })).toBeInTheDocument();
  });

  it("opens on click inside a clickable row without activating the row", async () => {
    const onRowClick = vi.fn();
    render(
      <Table aria-label="t">
        <Tbody>
          <Tr isClickable onRowClick={onRowClick}>
            <Td><HelpPopover label="row" body="Row help body" /></Td>
          </Tr>
        </Tbody>
      </Table>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More information about row" }));
    expect(await screen.findByText("Row help body")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens on Enter inside a clickable row without activating the row", async () => {
    const onRowClick = vi.fn();
    render(
      <Table aria-label="t">
        <Tbody>
          <Tr isClickable onRowClick={onRowClick}>
            <Td><HelpPopover label="row" body="Row help body" /></Td>
          </Tr>
        </Tbody>
      </Table>,
    );
    const trigger = screen.getByRole("button", { name: "More information about row" });
    trigger.focus();
    // A native button turns Enter into a click; jsdom does not, so both are dispatched.
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(await screen.findByText("Row help body")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not sort when the column help in a sortable header is used", async () => {
    const onSort = vi.fn();
    render(
      <Table aria-label="t">
        <Thead>
          <Tr>
            <Th
              sort={{ sortBy: { index: 0, direction: "asc" }, onSort, columnIndex: 0 }}
              info={helpInfo("size", "Size help body")}
            >
              Size
            </Th>
          </Tr>
        </Thead>
      </Table>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More information about size" }));
    await waitFor(() => expect(screen.getByText("Size help body")).toBeInTheDocument());
    expect(onSort).not.toHaveBeenCalled();
  });
});
