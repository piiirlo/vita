import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api.ts";
import { QueryErrorAlert } from "./QueryErrorAlert.tsx";
import { queryErrorDetails, queryErrorSummary, toQueryError } from "./queryError.ts";

const TIME_ERROR = {
  kind: "not_found",
  message: "function date_trunc(unknown, bigint) does not exist. Hint: No function matches",
  line: null,
  column: null,
  title: "A date function got a value that isn't a date",
  hint: "A number or text column is probably being used as a date.",
  raw: "function date_trunc(unknown, bigint) does not exist\nLINE 2: CAST(DATE_TRUNC('year', \"year\")",
};

describe("QueryErrorAlert", () => {
  it("says what went wrong in plain words, with the raw error under Details", () => {
    render(<QueryErrorAlert error={TIME_ERROR} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Error: A date function got a value that isn't a date");
    expect(alert).toHaveTextContent("A number or text column is probably being used as a date.");
    expect(screen.queryByText(/LINE 2/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/LINE 2/)).toBeInTheDocument();
  });

  it("shows unknown errors as they are, without Details", () => {
    render(<QueryErrorAlert error={{ kind: "other", message: "something odd", line: null, column: null }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Error: something odd");
    expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
  });

  it("turns any thrown error into one", () => {
    expect(toQueryError(new ApiError(400, "x", TIME_ERROR))).toBe(TIME_ERROR);
    expect(toQueryError(new Error("boom"))).toMatchObject({ kind: "other", message: "boom" });
    expect(queryErrorSummary(TIME_ERROR)).toBe(TIME_ERROR.title);
    expect(queryErrorDetails(TIME_ERROR)).toBe(TIME_ERROR.raw);
    // A title without raw text: the detailed message goes under Details.
    expect(queryErrorDetails({ ...TIME_ERROR, raw: null })).toBe(TIME_ERROR.message);
  });
});
