import { useMemo } from "react";
import type { TextTileSpec } from "../api.ts";
import { renderMarkdown } from "./markdown.ts";

type Props = {
  tile: TextTileSpec;
  editing: boolean;
  onChange(text: string): void;
  onRemove(): void;
};

/** Markdown text (titles, notes). Edited as plain markdown in edit mode. */
export default function TextTile({ tile, editing, onChange, onRemove }: Props) {
  const html = useMemo(() => renderMarkdown(tile.text), [tile.text]);

  if (editing) {
    return (
      <div className="dash-tile-inner" data-testid={`tile-${tile.id}`}>
        <div className="dash-tile-header dash-drag-handle">
          <span className="dash-tile-title muted">Text (Markdown)</span>
          <span className="spacer" />
          <button className="icon small" onClick={onRemove} aria-label="Remove text" title="Remove from dashboard">
            ×
          </button>
        </div>
        <textarea
          className="dash-text-editor mono"
          aria-label="Text (Markdown)"
          value={tile.text}
          placeholder="## Title, **bold**, - lists, [links](https://…)"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="dash-tile-inner dash-text" data-testid={`tile-${tile.id}`}>
      {/* Sanitized by renderMarkdown (DOMPurify). */}
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
