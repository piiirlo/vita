import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TestResultMessage from "./TestResultMessage.tsx";

describe("TestResultMessage", () => {
  it("shows a clear 'Connected' success state with a check icon", () => {
    render(<TestResultMessage result={{ ok: true, error: null }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Connected");
    expect(status.querySelector("svg.test-ok-icon circle")).not.toBeNull();
    expect(status.querySelector("svg.test-ok-icon path")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error with the word 'Error' (never color alone)", () => {
    render(<TestResultMessage result={{ ok: false, error: "password authentication failed" }} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Error:");
    expect(alert).toHaveTextContent("password authentication failed");
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("has a smaller compact version for the connections list", () => {
    render(<TestResultMessage result={{ ok: true, error: null }} compact />);
    const icon = screen.getByTestId("test-ok").querySelector("svg");
    expect(icon).toHaveAttribute("width", "18");
  });

  it("falls back to a generic message when the error is empty", () => {
    render(<TestResultMessage result={{ ok: false, error: null }} compact />);
    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed.");
  });
});
