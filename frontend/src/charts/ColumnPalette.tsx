import { Plus, Search } from "lucide-react";
import { useState } from "react";
import type { Dataset } from "../api.ts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { COLUMN_MIME, columnKind } from "./columnKinds.ts";
import { paletteColumns, SECTION_TITLES, type SectionId } from "./editorSections.ts";

type Props = {
  dataset: Dataset;
  /** The sections a column can go to (for its "Add to…" menu). */
  targetsFor(name: string): SectionId[];
  onAdd(section: SectionId, name: string): void;
};

/** The dataset's columns, searchable, with type icons. Drag one onto a section, or use its
 * "Add to…" menu (the keyboard way). */
export default function ColumnPalette({ dataset, targetsFor, onAdd }: Props) {
  const [search, setSearch] = useState("");
  const columns = paletteColumns(dataset, search);
  return (
    <section className="column-palette" aria-label="Columns">
      <div className="column-palette-head">
        <h3 className="control-heading">Columns</h3>
        <span className="muted small">Drag onto a section</span>
      </div>
      <label className="column-search">
        <Search size={14} aria-hidden />
        <input type="search" aria-label="Search columns" placeholder="Search columns" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ul className="column-list" aria-label="Dataset columns">
        {columns.map((c) => {
          const { icon: Icon, word } = columnKind(c);
          const name = c.label || c.name;
          return (
            <li
              key={c.name}
              className="column-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(COLUMN_MIME, c.name);
                e.dataTransfer.setData("text/plain", c.name);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <Icon size={14} className="column-icon" aria-hidden />
              <span className="column-name" title={c.name}>
                {name}
              </span>
              <span className="sr-only">, {word}</span>
              <span className="column-type" aria-hidden>
                {word}
              </span>
              <AddMenu name={name} targets={() => targetsFor(c.name)} onAdd={(section) => onAdd(section, c.name)} />
            </li>
          );
        })}
        {columns.length === 0 && <li className="muted small column-none">No column matches “{search}”.</li>}
      </ul>
    </section>
  );
}

function AddMenu({ name, targets, onAdd }: { name: string; targets(): SectionId[]; onAdd(section: SectionId): void }) {
  const [open, setOpen] = useState(false);
  const list = open ? targets() : [];
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="icon small column-add" aria-label={`Add ${name} to…`} title="Add to a section">
          <Plus size={14} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Add {name} to</DropdownMenuLabel>
        {list.map((section) => (
          <DropdownMenuItem key={section} onSelect={() => onAdd(section)}>
            {SECTION_TITLES[section]}
          </DropdownMenuItem>
        ))}
        {open && list.length === 0 && <DropdownMenuLabel>Nowhere in this chart</DropdownMenuLabel>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
