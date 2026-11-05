import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

export type TileMenuItem = { label: string; disabled?: boolean } & ({ onSelect(): void; to?: never } | { to: string; onSelect?: never });

/** The small "⋯" menu in a tile header. */
export default function TileMenu({ label, items }: { label: string; items: TileMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="tile-menu" ref={ref}>
      <button className="icon small" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open && (
        <div className="tile-menu-list" role="menu">
          {items.map((item) =>
            item.to !== undefined ? (
              <Link key={item.label} role="menuitem" to={item.to} className="tile-menu-item">
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                role="menuitem"
                className="tile-menu-item"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
