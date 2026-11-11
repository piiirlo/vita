import { useState } from "react";
import { deleteDataset, type DatasetListItem } from "../api.ts";
import ConfirmDialog from "../components/ConfirmDialog.tsx";
import { toast } from "../components/toast.ts";

type Props = {
  dataset: Pick<DatasetListItem, "id" | "name" | "is_upload" | "table_name">;
  onDeleted(): void;
  onCancel(): void;
};

/** "Delete dataset". A dataset made from an uploaded file can take its table with it (the
 * server refuses while other datasets read that table, and the dialog shows why). */
export default function DeleteDatasetDialog({ dataset, onDeleted, onCancel }: Props) {
  const [dropTable, setDropTable] = useState(false);

  async function confirm() {
    await deleteDataset(dataset.id, dataset.is_upload && dropTable);
    toast.success(dropTable && dataset.is_upload ? `Deleted "${dataset.name}" and its table.` : `Deleted "${dataset.name}".`);
    onDeleted();
  }

  return (
    <ConfirmDialog title="Delete dataset" confirmLabel="Delete" onConfirm={confirm} onCancel={onCancel}>
      <p>
        Delete <strong>{dataset.name}</strong> with its column settings and metrics? This cannot be undone.
        {dataset.is_upload ? null : " The table or query in the database is not affected."}
      </p>
      {dataset.is_upload && (
        <label className="checkbox delete-table-check">
          <input type="checkbox" checked={dropTable} onChange={(e) => setDropTable(e.target.checked)} />
          <span>
            Also delete its table <span className="mono">{dataset.table_name}</span> and the uploaded data in it
          </span>
        </label>
      )}
    </ConfirmDialog>
  );
}
