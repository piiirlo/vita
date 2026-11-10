import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConfirmDialog from "../ConfirmDialog.tsx";
import { Modal } from "./dialog.tsx";

describe("dialogs (keyboard)", () => {
  it("Modal: focus moves inside, Escape closes", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Save query" onClose={onClose}>
        <input aria-label="Name" />
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Save query" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ConfirmDialog: Cancel has focus, Escape cancels, errors say Error", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn(() => Promise.reject(new Error("Still used by 2 charts")));
    render(
      <ConfirmDialog title="Delete chart" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel}>
        <p>Delete it?</p>
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Delete chart" });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Error: Still used by 2 charts");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
