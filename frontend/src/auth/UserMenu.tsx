import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "../components/toast.ts";
import { useAuth } from "./auth.ts";
import ChangePasswordDialog from "./ChangePasswordDialog.tsx";

/** Top bar: the logged-in user, with "Change password" and "Log out". */
export default function UserMenu({ username }: { username: string }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function doLogout() {
    setOpen(false);
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (err) {
      toast.error(`Couldn't log out: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {username} ▾
      </button>
      {open && (
        <div className="tile-menu-list" role="menu">
          <button
            role="menuitem"
            className="tile-menu-item"
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
          >
            Change password
          </button>
          <button role="menuitem" className="tile-menu-item" onClick={() => void doLogout()}>
            Log out
          </button>
        </div>
      )}
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </div>
  );
}
