import {
  Activity,
  ChartLine,
  CodeXml,
  Database,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Moon,
  Network,
  Sun,
  SunMoon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
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
import { useTheme, type ThemePreference } from "../theme/theme.ts";

const NAV = [
  { to: "/dashboards", label: "Dashboards", icon: LayoutDashboard },
  { to: "/sql-lab", label: "SQL Lab", icon: CodeXml },
  { to: "/charts", label: "Charts", icon: ChartLine },
  { to: "/datasets", label: "Datasets", icon: Database },
  { to: "/connections", label: "Connections", icon: Network },
] as const;

const PHONE_QUERY = "(max-width: 767px)";

const itemClass = (active: boolean) =>
  cn(
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-control border no-underline",
    "transition-[background-color,border-color,color] duration-200 ease-out",
    active
      ? "border-inverse bg-inverse text-inverse-fg"
      : "border-transparent text-muted hover:border-border-hover hover:bg-hover hover:text-text",
  );

/** The slim icon rail (left); a bottom bar on phones. */
export default function Rail({ username }: { username: string }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const side = phone ? "top" : "right";
  const theme = useTheme();
  const ThemeIcon = theme.resolved === "dark" ? Sun : Moon;
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Main"
      className={cn(
        "z-40 flex items-center gap-2.5 border-border bg-[var(--rail-bg)] backdrop-blur-[14px]",
        "fixed inset-x-0 bottom-0 h-16 flex-row justify-around border-t px-2",
        "md:sticky md:top-0 md:h-screen md:w-[72px] md:shrink-0 md:flex-col md:justify-start md:border-r md:border-t-0 md:px-0 md:py-5",
      )}
    >
      <Tooltip content="Vita" side={side}>
        <Link
          to="/dashboards"
          aria-label="Vita home"
          className="hidden h-10 w-10 items-center justify-center rounded-control bg-accent text-xl font-bold text-accent-fg no-underline hover:no-underline md:mb-[18px] md:flex"
        >
          V
        </Link>
      </Tooltip>

      {NAV.map(({ to, label, icon: Icon }) => {
        // className must be a string here: the tooltip trigger (asChild) merges class names
        // as strings, so NavLink's function form would break.
        const active = pathname === to || pathname.startsWith(to + "/");
        return (
          <Tooltip key={to} content={label} side={side}>
            <NavLink to={to} aria-label={label} className={itemClass(active)}>
              <Icon size={20} strokeWidth={1.7} aria-hidden />
            </NavLink>
          </Tooltip>
        );
      })}

      <div className="hidden flex-1 md:block" />

      <Tooltip content={theme.resolved === "dark" ? "Light theme" : "Dark theme"} side={side}>
        <button
          type="button"
          onClick={theme.toggle}
          aria-label={theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          className={cn(itemClass(false), "cursor-pointer bg-transparent p-0")}
        >
          <ThemeIcon size={19} strokeWidth={1.7} aria-hidden />
        </button>
      </Tooltip>

      <AccountMenu username={username} side={side} />
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
        <DropdownMenuTrigger
          aria-label={`Account menu for ${username}`}
          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border-strong bg-surface p-0 font-sans text-sm font-semibold text-text uppercase hover:border-border-hover"
        >
          {username.slice(0, 1)}
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

