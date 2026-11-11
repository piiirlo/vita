import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadColumnPreview, UploadJob, UploadPreview, UploadReadOptions } from "../api.ts";
import { setPendingFile } from "../uploads/fileDrop.ts";
import { formatBytes, problemsKey, sameReadOptions, withReadOption } from "../uploads/uploads.ts";
import DatasetsPage from "./DatasetsPage.tsx";
import UploadPage from "./UploadPage.tsx";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const OPTIONS: UploadReadOptions = {
  encoding: "utf-8",
  delimiter: ";",
  header: true,
  skip_rows: 0,
  decimal: ",",
  thousands: "",
  columns: [
    { index: 0, name: "produit", type: "text", ignore: false, date_order: null },
    { index: 1, name: "prix", type: "decimal", ignore: false, date_order: null },
  ],
};

function column(index: number, extra: Partial<UploadColumnPreview> = {}): UploadColumnPreview {
  const base = OPTIONS.columns![index]!;
  return {
    index,
    source_name: index === 0 ? "Produit" : "Prix",
    name: base.name,
    type: base.type,
    guessed_type: base.type,
    ignore: false,
    date_order: null,
    date_ambiguous: false,
    checked: 3,
    misfits: 0,
    examples: [],
    locked: false,
    status: null,
    ...extra,
  };
}

const PREVIEW: UploadPreview = {
  upload_id: 5,
  file_name: "ventes.csv",
  file_size: 2048,
  file_kind: "csv",
  sheets: [],
  mode: "create",
  target: null,
  missing_columns: [],
  dataset_name: "ventes",
  options: OPTIONS,
  detected: OPTIONS,
  columns: [column(0), column(1)],
  rows: [
    ["Crème brûlée", "4,20"],
    ["Café", "1,50"],
  ],
  bad_cells: [],
  problems: [],
  sampled_rows: 2,
  more_rows: false,
};

function job(extra: Partial<UploadJob> = {}): UploadJob {
  return {
    id: 5,
    file_name: "ventes.csv",
    file_size: 2048,
    status: "importing",
    mode: "create",
    progress: 0.4,
    rows_done: 1,
    row_count: null,
    table_name: "ventes",
    dataset_id: null,
    error: null,
    bad_values: [],
    created_at: "2026-11-11T10:00:00Z",
    finished_at: null,
    ...extra,
  };
}

/** The URLs the fake XHR opened (the upload endpoint, with its query). */
let openedUrls: string[] = [];

/** XHR stand-in for the file upload (fetch can't report upload progress). */
function stubXhr(response: { status: number; body: unknown }) {
  const sent: { name: string | null; body: unknown }[] = [];
  openedUrls = [];
  class FakeXhr {
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private headers: Record<string, string> = {};
    open(_method: string, url: string) {
      openedUrls.push(url);
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    abort() {}
    send(body: unknown) {
      sent.push({ name: this.headers["X-File-Name"] ?? null, body });
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
        this.status = response.status;
        this.responseText = JSON.stringify(response.body);
        this.onload?.();
      }, 0);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return sent;
}

type Call = { url: string; method: string; body: unknown };

function stubFetch(handler: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      const call = { url: String(input), method: init?.method ?? "GET", body };
      calls.push(call);
      return handler(call) ?? json({ detail: `unexpected ${call.url}` }, 404);
    }),
  );
  return calls;
}

function DatasetStub() {
  return <p>Dataset {useParams().id}</p>;
}

function renderUpload(entry = "/datasets/upload") {
  const router = createMemoryRouter(
    [
      { path: "/datasets", element: <DatasetsPage /> },
      { path: "/datasets/upload", element: <UploadPage /> },
      { path: "/datasets/:id", element: <DatasetStub /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const csv = () => new File(["Produit;Prix\nCrème brûlée;4,20\n"], "ventes.csv", { type: "text/csv" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("upload helpers", () => {
  it("re-guesses the columns when how the file is split changes, not otherwise", () => {
    expect(withReadOption(OPTIONS, "delimiter", ",").columns).toBeNull();
    expect(withReadOption(OPTIONS, "header", false).columns).toBeNull();
    expect(withReadOption(OPTIONS, "skip_rows", 2)).toMatchObject({ skip_rows: 2, columns: null });
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(problemsKey([{ kind: "misfit", column: 1, message: "", examples: [], blocking: false }])).toBe("misfit:1");
  });
});

describe("Datasets page: upload entry points", () => {
  it("has an Upload file button", async () => {
    stubFetch((c) => (c.url.startsWith("/api/datasets") ? json([]) : undefined));
    renderUpload("/datasets");
    expect(await screen.findByRole("button", { name: "Upload file" })).toBeInTheDocument();
  });

  it("dropping a file anywhere on the page opens the upload with it", async () => {
    stubFetch((c) => (c.url.startsWith("/api/datasets") ? json([]) : undefined));
    const sent = stubXhr({ status: 201, body: PREVIEW });
    const router = renderUpload("/datasets");
    await screen.findByRole("button", { name: "Upload file" });
    const file = csv();
    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], dropEffect: "none" } });
      act(() => {
        window.dispatchEvent(event);
      });
    };
    drag("dragenter");
    expect(screen.getByText("Drop the file to make a dataset")).toBeInTheDocument();
    drag("dragover");
    drag("drop");
    await waitFor(() => expect(router.state.location.pathname).toBe("/datasets/upload"));
    expect(await screen.findByRole("heading", { name: "ventes.csv" })).toBeInTheDocument();
    expect(sent).toEqual([{ name: "ventes.csv", body: file }]);
  });
});

describe("Upload page", () => {
  it("file -> preview -> Create dataset -> progress -> the new dataset (adjust panel closed)", async () => {
    stubXhr({ status: 201, body: PREVIEW });
    let polls = 0;
    const calls = stubFetch((c) => {
      if (c.url === "/api/uploads/5/import") return json(job(), 202);
      if (c.url === "/api/uploads/5") return json(++polls < 2 ? job({ progress: 0.7 }) : job({ status: "done", progress: 1, row_count: 2, dataset_id: 9 }));
      return undefined;
    });
    setPendingFile(csv());
    const router = renderUpload();

    expect(await screen.findByRole("heading", { name: "ventes.csv" })).toBeInTheDocument();
    expect(screen.getByLabelText("Dataset name")).toHaveValue("ventes");
    expect(screen.getByRole("cell", { name: "Crème brûlée" })).toBeInTheDocument(); // accents as parsed
    const toggle = screen.getByRole("button", { name: /Adjust how the file is read/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false"); // nothing looks wrong

    fireEvent.change(screen.getByLabelText("Dataset name"), { target: { value: "Ventes de mars" } });
    fireEvent.click(screen.getByRole("button", { name: "Create dataset" }));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/datasets/9"), { timeout: 4000 });
    expect(calls.find((c) => c.url === "/api/uploads/5/import")?.body).toEqual({ options: OPTIONS, dataset_name: "Ventes de mars", on_error: "null" });
  });

  it("opens the adjust panel by itself on a problem, with the column marked", async () => {
    const withProblem: UploadPreview = {
      ...PREVIEW,
      columns: [column(0), column(1, { misfits: 2, examples: [{ row: 2, value: "oops" }, { row: 3, value: "n.c." }] })],
      bad_cells: [[1, 1]],
      problems: [{ kind: "misfit", column: 1, message: '"Prix": 2 of 3 values aren\'t a valid decimal.', examples: ["oops"], blocking: false }],
    };
    stubXhr({ status: 201, body: withProblem });
    stubFetch(() => undefined);
    setPendingFile(csv());
    renderUpload();
    const toggle = await screen.findByRole("button", { name: /Adjust how the file is read/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Problems" })).getByText(/2 of 3 values aren't a valid decimal/)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Prix: "Prix": 2 of 3/ })).toHaveClass("has-problem");
    expect(screen.getByText(/2 of 3 aren’t decimal: “oops”, “n.c.”/)).toBeInTheDocument();
    // The bad cell in the preview is marked (not by color alone).
    expect(screen.getByRole("cell", { name: /1,50 \(doesn’t fit the column type\)/ })).toHaveClass("cell-bad");
  });

  it("changing a read option re-reads the file (columns guessed again) and shows the new preview", async () => {
    stubXhr({ status: 201, body: { ...PREVIEW, problems: [{ kind: "one_column", column: null, message: "Everything is in one column", examples: [], blocking: false }] } });
    const calls = stubFetch((c) => {
      if (c.url === "/api/uploads/5/preview") return json({ ...PREVIEW, rows: [["Thé", "2,00"]] });
      return undefined;
    });
    setPendingFile(csv());
    renderUpload();
    fireEvent.change(await screen.findByLabelText("Delimiter"), { target: { value: "," } });
    expect(await screen.findByRole("cell", { name: "Thé" })).toBeInTheDocument();
    expect(calls.at(-1)!.body).toMatchObject({ delimiter: ",", columns: null });

    // A column type is sent with the columns; a name change alone doesn't re-read the file.
    const before = calls.length;
    fireEvent.change(screen.getByLabelText("Name of Prix"), { target: { value: "prix_ttc" } });
    expect(calls.length).toBe(before);
    fireEvent.change(screen.getByLabelText("Type of Prix"), { target: { value: "text" } });
    await waitFor(() => expect(calls.length).toBe(before + 1));
    expect((calls.at(-1)!.body as UploadReadOptions).columns![1]).toMatchObject({ name: "prix_ttc", type: "text" });
  });

  it("ambiguous dates: Create is disabled until the order is picked", async () => {
    const ambiguous: UploadPreview = {
      ...PREVIEW,
      options: { ...OPTIONS, columns: [OPTIONS.columns![0]!, { index: 1, name: "jour", type: "date", ignore: false, date_order: null }] },
      columns: [column(0), column(1, { source_name: "Jour", name: "jour", type: "date", guessed_type: "date", date_ambiguous: true })],
      problems: [{ kind: "ambiguous_date", column: 1, message: '"Jour": dates like 03/04/2024 read both ways. Pick the order.', examples: [], blocking: true }],
    };
    stubXhr({ status: 201, body: ambiguous });
    const calls = stubFetch((c) =>
      c.url === "/api/uploads/5/preview"
        ? json({ ...ambiguous, options: c.body, columns: [column(0), column(1, { source_name: "Jour", name: "jour", type: "date", date_order: "dmy", date_ambiguous: true })], problems: [] })
        : undefined,
    );
    setPendingFile(csv());
    renderUpload();
    const create = await screen.findByRole("button", { name: "Create dataset" });
    expect(create).toBeDisabled();
    const order = screen.getByLabelText("Date order of Jour");
    expect(order).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(order, { target: { value: "dmy" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create dataset" })).toBeEnabled());
    expect((calls.at(-1)!.body as UploadReadOptions).columns![1]!.date_order).toBe("dmy");
  });

  it("reports values that didn't fit, then opens the dataset", async () => {
    stubXhr({ status: 201, body: PREVIEW });
    stubFetch((c) => {
      if (c.url === "/api/uploads/5/import") return json(job(), 202);
      if (c.url === "/api/uploads/5")
        return json(job({ status: "done", row_count: 41, dataset_id: 9, bad_values: [{ column: "prix", count: 2, examples: [{ row: 40, value: "oops" }] }] }));
      return undefined;
    });
    setPendingFile(csv());
    const router = renderUpload();
    fireEvent.click(await screen.findByRole("button", { name: "Create dataset" }));
    const report = await screen.findByRole("region", { name: "Import report" }, { timeout: 4000 });
    expect(report).toHaveTextContent("41 rows were imported");
    expect(report).toHaveTextContent("prix: 2 values, e.g. “oops” (row 40)");
    fireEvent.click(within(report).getByRole("button", { name: "Open the dataset" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/datasets/9"));
  });

  it("a failed upload says why, and can be tried again", async () => {
    stubXhr({ status: 413, body: { detail: "The file is larger than 50 MB, the most an upload can be." } });
    stubFetch(() => undefined);
    setPendingFile(csv());
    renderUpload();
    expect(await screen.findByRole("alert")).toHaveTextContent("The file is larger than 50 MB");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeInTheDocument();
  });
});

describe("Upload page: Excel", () => {
  const EXCEL: UploadPreview = {
    ...PREVIEW,
    file_name: "ventes.xlsx",
    file_kind: "xlsx",
    sheets: ["Couverture", "Ventes", "Stock"],
    options: { ...OPTIONS, delimiter: ",", decimal: ".", sheet: "Ventes" },
    detected: { ...OPTIONS, delimiter: ",", decimal: ".", sheet: "Ventes" },
  };

  it("picks another sheet (columns guessed again); no delimiter or encoding settings", async () => {
    stubXhr({ status: 201, body: EXCEL });
    const calls = stubFetch((c) => (c.url === "/api/uploads/5/preview" ? json({ ...EXCEL, options: { ...EXCEL.options, sheet: "Stock" }, rows: [["Thé", "2"]] }) : undefined));
    setPendingFile(new File(["PK"], "ventes.xlsx"));
    renderUpload();
    fireEvent.click(await screen.findByRole("button", { name: /Adjust how the file is read/ }));
    const sheet = screen.getByLabelText("Sheet");
    expect(within(sheet).getAllByRole("option").map((o) => o.textContent)).toEqual(["Couverture", "Ventes (detected)", "Stock"]);
    expect(screen.queryByLabelText("Delimiter")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Encoding")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Decimal separator")).not.toBeInTheDocument();
    fireEvent.change(sheet, { target: { value: "Stock" } });
    expect(await screen.findByRole("cell", { name: "Thé" })).toBeInTheDocument();
    expect(calls.at(-1)!.body).toMatchObject({ sheet: "Stock", columns: null });
    // Back to what was detected.
    fireEvent.click(screen.getByRole("button", { name: /Reset to detected/ }));
    await waitFor(() => expect(calls.at(-1)!.body).toMatchObject({ sheet: "Ventes" }));
  });
});

describe("Upload page: replace / append", () => {
  const DATASET = {
    id: 7,
    name: "Ventes",
    columns: [
      { name: "produit", is_missing: false },
      { name: "prix", is_missing: false },
    ],
  };
  const TARGET = { id: 7, name: "Ventes", table_name: "ventes" };

  function stubTarget(extra: (c: Call) => Response | undefined = () => undefined) {
    return stubFetch((c) => (c.url === "/api/datasets/7" ? json(DATASET) : extra(c)));
  }

  it("replace: matched columns are locked, a new one is marked, and Replace data asks first", async () => {
    const replacing: UploadPreview = {
      ...PREVIEW,
      mode: "replace",
      target: TARGET,
      dataset_name: "Ventes",
      columns: [column(0, { locked: true, status: "matched" }), column(1, { locked: true, status: "matched" }), { ...column(1), index: 2, source_name: "Canal", name: "canal", status: "new" }],
      options: { ...OPTIONS, columns: [...OPTIONS.columns!, { index: 2, name: "canal", type: "text", ignore: false, date_order: null }] },
      problems: [{ kind: "columns_mismatch", column: null, message: "New column “canal” will be added to the dataset.", examples: ["canal"], blocking: false }],
    };
    stubXhr({ status: 201, body: replacing });
    let polls = 0;
    const calls = stubTarget((c) => {
      if (c.url === "/api/uploads/5/import") return json(job({ mode: "replace" }), 202);
      if (c.url === "/api/uploads/5") return json(++polls < 2 ? job() : job({ status: "done", progress: 1, row_count: 2, dataset_id: 7 }));
      return undefined;
    });
    const router = renderUpload("/datasets/upload?dataset=7&mode=replace");
    expect(await screen.findByRole("heading", { name: "Replace the data of Ventes" })).toBeInTheDocument();
    expect(screen.getByText(/matched by name/)).toHaveTextContent("produit, prix");
    fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [csv()] } });

    expect(await screen.findByRole("heading", { name: "ventes.csv" })).toBeInTheDocument();
    expect(openedUrls).toEqual(["/api/uploads?dataset_id=7&mode=replace"]);
    expect(screen.queryByLabelText("Dataset name")).not.toBeInTheDocument();
    expect(screen.getByText("Replaces the data of")).toBeInTheDocument();
    expect(screen.getByLabelText("Type of Produit")).toBeDisabled();
    expect(screen.getByLabelText("Name of Produit")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Type of Canal")).toBeEnabled();
    expect(screen.getByText("new")).toHaveAttribute("title", expect.stringContaining("added as a new column"));

    fireEvent.click(screen.getByRole("button", { name: "Replace data" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Every row of Ventes is replaced by the rows of ventes.csv");
    expect(calls.some((c) => c.url === "/api/uploads/5/import")).toBe(false); // not before confirming
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace data" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/datasets/7"), { timeout: 4000 });
    expect(calls.find((c) => c.url === "/api/uploads/5/import")?.body).toMatchObject({ dataset_name: "Ventes" });
  });

  it("append: missing columns block the import, with their names", async () => {
    const short: UploadPreview = {
      ...PREVIEW,
      mode: "append",
      target: TARGET,
      dataset_name: "Ventes",
      missing_columns: ["prix"],
      problems: [{ kind: "columns_mismatch", column: null, message: "The file has no column for “prix” (every row needs them).", examples: ["prix"], blocking: true }],
    };
    stubXhr({ status: 201, body: short });
    stubTarget();
    renderUpload("/datasets/upload?dataset=7&mode=append");
    expect(await screen.findByRole("heading", { name: "Add rows to Ventes" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [csv()] } });
    expect(await screen.findByRole("button", { name: "Append rows" })).toBeDisabled();
    expect(openedUrls).toEqual(["/api/uploads?dataset_id=7&mode=append"]);
    expect(within(screen.getByRole("list", { name: "Problems" })).getByText(/no column for “prix”/)).toBeInTheDocument();
  });
});

describe("Delete dataset: its uploaded table", () => {
  const LIST = [
    { id: 3, name: "Ventes", description: null, connection_id: 2, connection_name: "Uploads", kind: "table", schema: "uploads", table_name: "ventes", column_count: 2, metric_count: 1, created_at: "2026-11-11T10:00:00Z", updated_at: "2026-11-11T10:00:00Z", is_upload: true },
    { id: 4, name: "Orders", description: null, connection_id: 1, connection_name: "Demo", kind: "table", schema: "sales", table_name: "orders", column_count: 5, metric_count: 1, created_at: "2026-11-11T10:00:00Z", updated_at: "2026-11-11T10:00:00Z", is_upload: false },
  ];

  async function openDelete(name: string) {
    const row = (await screen.findByRole("link", { name })).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    return screen.findByRole("alertdialog");
  }

  it("asks whether to delete the table too; a blocked delete says why and keeps the dialog", async () => {
    const calls = stubFetch((c) => {
      if (c.url === "/api/datasets" && c.method === "GET") return json(LIST);
      if (c.url === "/api/datasets/3?drop_table=true")
        return json({ detail: { message: "The table “ventes” can't be deleted: 1 other dataset uses it (Twin). Delete only the dataset, or those first.", datasets: ["Twin"] } }, 409);
      if (c.url === "/api/datasets/3") return new Response(null, { status: 204 });
      return undefined;
    });
    renderUpload("/datasets");
    expect(screen.queryByText("file")).not.toBeInTheDocument();
    expect(await screen.findByText("file")).toHaveClass("tag"); // the uploaded dataset's source

    let dialog = await openDelete("Ventes");
    const check = within(dialog).getByRole("checkbox", { name: /Also delete its table ventes/ });
    expect(check).not.toBeChecked(); // the table stays unless asked
    fireEvent.click(check);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText(/can't be deleted: 1 other dataset uses it \(Twin\)/)).toBeInTheDocument();

    fireEvent.click(check);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/datasets/3?drop_table=true", "/api/datasets/3"]);

    dialog = await openDelete("Orders");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("The table or query in the database is not affected.");
  });
});

describe("upload helpers: Excel and reset", () => {
  it("a sheet change re-guesses the columns; sameReadOptions ignores unguessed columns", () => {
    expect(withReadOption({ ...OPTIONS, sheet: "A" }, "sheet", "B")).toMatchObject({ sheet: "B", columns: null });
    expect(sameReadOptions(OPTIONS, { ...OPTIONS })).toBe(true);
    expect(sameReadOptions(OPTIONS, { ...OPTIONS, columns: null })).toBe(true);
    expect(sameReadOptions(OPTIONS, { ...OPTIONS, header: false })).toBe(false);
    expect(sameReadOptions(OPTIONS, { ...OPTIONS, columns: [{ ...OPTIONS.columns![0]!, type: "integer" }, OPTIONS.columns![1]!] })).toBe(false);
  });
});
