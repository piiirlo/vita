/** Part 13: the upload preview shows dates unambiguously, with their format (changeable), and
 * says which values mean "no value" and which column holds years. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UploadColumnPreview, UploadPreview, UploadReadOptions } from "../api.ts";
import PreviewTable from "./PreviewTable.tsx";

const OPTIONS: UploadReadOptions = {
  encoding: "utf-8", delimiter: ",", header: true, skip_rows: 0, decimal: ".", thousands: "",
  columns: [
    { index: 0, name: "order_date", type: "date", ignore: false, date_order: "dmy" },
    { index: 1, name: "year", type: "integer", ignore: false, date_order: null },
    { index: 2, name: "postal_code", type: "text", ignore: false, date_order: null },
  ],
};  // prettier-ignore

function column(index: number, extra: Partial<UploadColumnPreview>): UploadColumnPreview {
  const base = OPTIONS.columns![index]!;
  return {
    index, source_name: base.name, name: base.name, type: base.type, guessed_type: base.type,
    ignore: false, date_order: null, date_ambiguous: false, checked: 3, misfits: 0, examples: [],
    locked: false, status: null, ...extra,
  };  // prettier-ignore
}

const PREVIEW: UploadPreview = {
  upload_id: 1, file_name: "superstore.csv", file_size: 100, file_kind: "csv", sheets: [], mode: "create",
  target: null, missing_columns: [], dataset_name: "superstore", options: OPTIONS, detected: OPTIONS,
  columns: [
    column(0, { date_order: "dmy" }),
    column(1, { years: "name", null_words: 2 }),
    column(2, {}),
  ],
  rows: [
    ["9/11/2013", "2006", "42420"],
    ["13-06-2013", "N/A", "02134"],
  ],
  bad_cells: [], problems: [], sampled_rows: 2, more_rows: false,
};  // prettier-ignore

describe("Upload preview", () => {
  it("shows parsed dates unambiguously, the original on hover", () => {
    render(<PreviewTable preview={PREVIEW} options={OPTIONS} busy={false} />);
    const cell = screen.getByText("9 Nov 2013");
    expect(cell).toHaveAttribute("title", "In the file: 9/11/2013");
    expect(screen.getByText("13 Jun 2013")).toBeInTheDocument();
    // Text stays as it is (leading zeros kept).
    expect(screen.getByText("02134")).toBeInTheDocument();
  });

  it("shows the detected format, and changes it", () => {
    const onDateOrder = vi.fn();
    render(<PreviewTable preview={PREVIEW} options={OPTIONS} busy={false} onDateOrder={onDateOrder} />);
    const format = screen.getByLabelText("Date format of order_date");
    expect(format).toHaveValue("dmy");
    expect(within(format).getByRole("option", { name: "Day first: DD-MM-YYYY" })).toBeInTheDocument();
    fireEvent.change(format, { target: { value: "mdy" } });
    expect(onDateOrder).toHaveBeenCalledWith(0, "mdy");
  });

  it("says which column holds years and how many values mean no value", () => {
    render(<PreviewTable preview={PREVIEW} options={OPTIONS} busy={false} />);
    expect(screen.getByText("years: a time column")).toBeInTheDocument();
    expect(screen.getByText("2 N/A → empty")).toBeInTheDocument();
  });

  it("asks for the order of ambiguous dates", () => {
    const ambiguous = { ...PREVIEW, columns: [column(0, { date_order: null, date_ambiguous: true }), ...PREVIEW.columns.slice(1)] };
    render(<PreviewTable preview={ambiguous} options={OPTIONS} busy={false} onDateOrder={vi.fn()} />);
    expect(screen.getByLabelText("Date format of order_date")).toHaveValue("");
    // Not read yet: the values stay as they are in the file.
    expect(screen.getByText("9/11/2013")).toBeInTheDocument();
  });
});
