import {
  Activity,
  ChartLine,
  CodeXml,
  Database,
  Folder,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  SunMoon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/auth.ts";
import ChangePasswordDialog from "../auth/ChangePasswordDialog.tsx";
import { toast } from "../components/toast.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Tooltip } from "../components/ui/tooltip.tsx";
import { useMediaQuery } from "../dashboards/hooks.ts";
import { cn } from "../lib/cn.ts";
import { gsap, motionOn, slidePill, themeReveal } from "../motion/ignara.ts";
import { innerPath, sectionOf } from "../projects/paths.ts";
import { useProject } from "../projects/projectContext.ts";
import { useTheme, type ThemePreference } from "../theme/theme.ts";

// Pages of a project (relative to /projects/:id; "" = the project page with its dashboards),
// and the same pages at the old top-level URLs (every project's items).
const NAV = [
  { to: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
  { to: "/sql-lab", label: "SQL Lab", icon: CodeXml },
  { to: "/charts", label: "Charts", icon: ChartLine },
  { to: "/datasets", label: "Datasets", icon: Database },
  { to: "/connections", label: "Connections", icon: Network },
] as const;

const PHONE_QUERY = "(max-width: 767px)";
// Between phones and wide screens the sidebar is always the icon rail (Ignara: 761-1279px).
const NARROW_QUERY = "(min-width: 768px) and (max-width: 1279px)";
const FOLD_KEY = "vita.sidebar.folded";

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLD_KEY, folded ? "1" : "0");
  } catch {
    // private mode: the choice just isn't remembered
  }
}

/** The sidebar (Ignara's): brand, Projects, the project's pages and, at the bottom, the theme
 * switch and the account menu. An icon rail on mid-size screens or when folded; a floating
 * bar at the bottom on phones. The active page has the ember pill, which slides between items.
 * Inside a project its links stay in the project; on the home page there is only "Projects". */
export default function Rail({ username }: { username: string }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [folded, setFolded] = useState(readFolded);
  const rail = !phone && (narrow || folded);
  const side = phone ? "top" : "right";
  const theme = useTheme();
  const ThemeIcon = theme.resolved === "dark" ? Sun : Moon;
  const { pathname } = useLocation();
  const project = useProject();
  const home = pathname === "/";
  const base = project ? `/projects/${project.id}` : "";
  const inner = project ? innerPath(pathname) : pathname;
  const nav = home
    ? []
    : NAV.map((item) => ({
        ...item,
        // In a project, "Dashboards" is the project page (its dashboards and data).
        href: project && item.to === "/dashboards" ? base : base + item.to,
        active:
          project && item.to === "/dashboards"
            ? ["home", "dashboards"].includes(sectionOf(inner))
            : inner === item.to || inner.startsWith(item.to + "/"),
      }));
  const activeKey = home ? "projects" : (nav.find((n) => n.active)?.to ?? null);

  // The ember pill covers the nav and is clipped to the active item; moving, it stretches
  // (Ignara's: leading edge first, trailing edge after). A resize just snaps it.
  const listRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const radius = phone ? 18 : 14;
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = () => list?.querySelector<HTMLElement>('[aria-current="page"]') ?? null;
    slidePill(pillRef.current, active(), { radius });
    if (!list || typeof ResizeObserver === "undefined") return;
    // Only a real size change snaps it: the observer also fires once right after observe(),
    // which would cut the stretch short.
    let size = `${list.offsetWidth}x${list.offsetHeight}`;
    const observer = new ResizeObserver(() => {
      const now = `${list.offsetWidth}x${list.offsetHeight}`;
      if (now === size) return;
      size = now;
      slidePill(pillRef.current, active(), { radius, animate: false });
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeKey, rail, phone, radius]);

  // Folding (Ignara's): the sidebar is clipped down to the rail (0.32s power3.inOut), then
  // becomes the rail while the page glides over (0.6s expo.out). Unfolding unclips it (0.5s
  // expo.out) and the labels slide in after it.
  const navRef = useRef<HTMLElement>(null);
  const mainLeft = useRef<number | null>(null);
  const unfolding = useRef(false);
  const RAIL_W = 84;
  function setFold(next: boolean) {
    writeFolded(next);
    mainLeft.current = document.querySelector("main")?.getBoundingClientRect().left ?? null;
    setFolded(next);
  }
  function toggleFold() {
    const side = navRef.current;
    if (!side || !motionOn()) return setFold(!folded);
    if (!folded) {
      gsap.to(side, {
        clipPath: `inset(0px ${side.offsetWidth - RAIL_W}px 0px 0px round 0px)`,
        duration: 0.32,
        ease: "power3.inOut",
        onComplete: () => {
          gsap.set(side, { clearProps: "clipPath" });
          setFold(true);
        },
      });
    } else {
      unfolding.current = true;
      setFold(false);
    }
  }
  useLayoutEffect(() => {
    const side = navRef.current;
    const main = document.querySelector("main");
    if (!side || !main || mainLeft.current === null || !motionOn()) return;
    const dx = mainLeft.current - main.getBoundingClientRect().left;
    mainLeft.current = null;
    gsap.fromTo(main, { x: dx }, { x: 0, duration: 0.6, ease: "expo.out", clearProps: "transform" });
    if (unfolding.current) {
      unfolding.current = false;
      gsap.fromTo(
        side,
        { clipPath: `inset(0px ${side.offsetWidth - RAIL_W}px 0px 0px round 0px)` },
        { clipPath: "inset(0px 0px 0px 0px round 0px)", duration: 0.5, ease: "expo.out", clearProps: "clipPath" },
      );
      gsap.fromTo(
        side.querySelectorAll(".side-label, .side-group, .side-brand-text, .side-me-text"),
        { x: -8, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.55, ease: "power3.out", stagger: 0.015, delay: 0.08, clearProps: "transform,opacity" },
      );
    }
  }, [folded]);

  const tip = (label: string, node: ReactNode) => (
    <Tooltip content={label} side={side}>
      {node}
    </Tooltip>
  );

  return (
    <nav ref={navRef} aria-label="Main" className={cn("side", rail && "is-rail", phone && "is-phone")}>
      <div className="side-head">
        {tip(
          "Vita",
          <Link to="/" aria-label="Vita home" className="side-brand">
            <span className="side-mark" aria-hidden>
              V
            </span>
            <span className="side-brand-text">
              <b>Vita</b>
              <small>Data, charts, dashboards</small>
            </span>
          </Link>,
        )}
        {!phone && !narrow && (
          <button
            type="button"
            className="side-fold"
            onClick={toggleFold}
            aria-label={folded ? "Expand the sidebar" : "Fold the sidebar"}
            aria-pressed={folded}
          >
            {folded ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
          </button>
        )}
      </div>

      <div className="side-nav" ref={listRef}>
        <span className="side-pill" ref={pillRef} aria-hidden />
        <span className="side-group">Workspace</span>
        {tip(
          "Projects",
          <NavLink to="/" end aria-label="Projects" className="side-item" aria-current={home ? "page" : undefined}>
            <Folder size={20} strokeWidth={1.7} aria-hidden />
            <span className="side-label">Projects</span>
          </NavLink>,
        )}

        {!home && (
          <span className="side-group" title={project?.project?.name}>
            {project?.project?.name ?? "Pages"}
          </span>
        )}
        {nav.map(({ to, href, label, icon: Icon, active }) => (
          // className must be a string: the tooltip trigger (asChild) merges class names as strings.
          <Tooltip key={to} content={label} side={side}>
            <Link to={href} aria-label={label} className="side-item" aria-current={active ? "page" : undefined}>
              <Icon size={20} strokeWidth={1.7} aria-hidden />
              <span className="side-label">{label}</span>
            </Link>
          </Tooltip>
        ))}
      </div>

      <div className="side-foot">
        {tip(
          theme.resolved === "dark" ? "Light theme" : "Dark theme",
          <button
            type="button"
            onClick={(e) => themeReveal(e.currentTarget, theme.toggle)}
            aria-label={theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            className="side-item side-theme"
          >
            <ThemeIcon size={19} strokeWidth={1.7} aria-hidden />
            <span className="side-label">{theme.resolved === "dark" ? "Light theme" : "Dark theme"}</span>
          </button>,
        )}
        <AccountMenu username={username} side={side} />
      </div>
    </nav>
  );
}

function AccountMenu({ username, side }: { username: string; side: "top" | "right" }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  const [changingPassword, setChangingPassword] = useState(false);

  async function doLogout() {
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (err) {
      toast.error(`Couldn't log out: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`Account menu for ${username}`} className="side-me">
          <span className="side-avatar" aria-hidden>
            {username.slice(0, 1)}
          </span>
          <span className="side-me-text">
            <b>{username}</b>
            <small>Account</small>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={side} align="end">
          <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
          <div className="px-2.5 pb-2 text-sm font-semibold">{username}</div>
          <DropdownMenuSeparator />
          <MenuLink icon={<Activity size={16} />} onSelect={() => void navigate("/status")}>
            Status
          </MenuLink>
          <MenuLink icon={<KeyRound size={16} />} onSelect={() => setChangingPassword(true)}>
            Change password
          </MenuLink>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SunMoon size={16} className="text-muted" aria-hidden />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme.preference} onValueChange={(v) => theme.setPreference(v as ThemePreference)}>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <MenuLink icon={<LogOut size={16} />} onSelect={() => void doLogout()}>
            Log out
          </MenuLink>
        </DropdownMenuContent>
      </DropdownMenu>
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
    </>
  );
}

function MenuLink({ icon, children, onSelect }: { icon: ReactNode; children: ReactNode; onSelect(): void }) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <span className="text-muted" aria-hidden>
        {icon}
      </span>
      {children}
    </DropdownMenuItem>
  );
}
