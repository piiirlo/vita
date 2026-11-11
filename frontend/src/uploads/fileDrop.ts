/** Files picked or dropped on the Datasets page, handed to the upload page, and drag-and-drop
 * of files anywhere on a page. */
import { useEffect, useRef, useState } from "react";

let pending: File | null = null;

/** Keep a file for the upload page (navigation can't carry it across a reload). */
export function setPendingFile(file: File): void {
  pending = file;
}

/** The waiting file, once. */
export function takePendingFile(): File | null {
  const file = pending;
  pending = null;
  return file;
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** While mounted, files dragged over the window show the drop overlay (`dragging`) and a drop
 * anywhere calls `onFile` with the first file. */
export function useFileDrop(onFile: (file: File) => void, enabled = true): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFile);
  handler.current = onFile;

  useEffect(() => {
    if (!enabled) return;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) handler.current(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [enabled]);
  return dragging;
}

/** File types the picker offers (the server detects the real format from the content). */
export const ACCEPTED_FILES =
  ".csv,.tsv,.txt,.tab,.xlsx,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
