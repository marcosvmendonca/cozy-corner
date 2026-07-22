import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { supabase } from "@/integrations/supabase/client";
import { Inbox, GitBranch, Settings, LogOut, MessageCircle, Users, Bell, BellOff } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/hooks/use-notifications";
import { toast } from "sonner";

const nav = [
  { to: "/inbox", label: "Atendimento", icon: Inbox },
  { to: "/flows", label: "Fluxos", icon: GitBranch },
  { to: "/contacts", label: "Contatos", icon: Users },
  { to: "/settings", label: "Configurações", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [profile, setProfile] = useState<{ name: string; email: string } | null>(null);
  const { permission, requestPermission, enabled, setEnabled, unread } = useNotifications();

  async function toggleNotifications() {
    if (!enabled) {
      if (permission !== "granted") {
        const p = await requestPermission();
        if (p !== "granted") toast.info("Notificações no navegador bloqueadas — usaremos apenas o som e o toast.");
      }
      setEnabled(true);
      toast.success("Notificações ativadas");
    } else {
      setEnabled(false);
      toast("Notificações silenciadas");
    }
  }

    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setProfile({
          name: (data.user.user_metadata?.full_name as string) || data.user.email?.split("@")[0] || "Você",
          email: data.user.email ?? "",
        });
      }
    });
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="flex w-[68px] shrink-0 flex-col items-center gap-2 border-r bg-sidebar py-4 text-sidebar-foreground md:w-60 md:items-stretch md:px-4">
        <Link to="/inbox" className="mb-4 flex items-center gap-3 md:px-2">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground shadow-lg">
            <MessageCircle className="h-5 w-5" />
          </div>
          <div className="hidden md:block">
            <div className="text-sm font-semibold leading-tight" style={{ fontFamily: "Instrument Serif, serif", fontSize: 20 }}>
              Zap Atende
            </div>
            <div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">CRM · IA</div>
          </div>
        </Link>

        <nav className="flex flex-1 flex-col gap-1">
          {nav.map((item) => {
            const active = path.startsWith(item.to);
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                )}
              >
                {active && (
                  <motion.div
                    layoutId="active-nav"
                    className="absolute inset-y-1 left-0 w-1 rounded-full bg-sidebar-primary"
                    transition={{ type: "spring", bounce: 0.2, duration: 0.5 }}
                  />
                )}
                <Icon className="h-[18px] w-[18px] shrink-0" />
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-2 md:px-1">
          <div className="flex items-center gap-2 rounded-xl bg-sidebar-accent/40 p-2">
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                {profile?.name?.[0]?.toUpperCase() ?? "?"}
              </AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 flex-1 md:block">
              <div className="truncate text-xs font-medium">{profile?.name}</div>
              <div className="truncate text-[10px] text-sidebar-foreground/60">{profile?.email}</div>
            </div>
            <Button variant="ghost" size="icon" onClick={signOut} className="h-8 w-8 shrink-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
