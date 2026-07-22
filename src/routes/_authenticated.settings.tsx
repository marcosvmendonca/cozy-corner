import { createFileRoute, Outlet, useRouterState, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

const tabs = [
  { to: "/settings/integration", label: "WhatsApp" },
  { to: "/settings/ai", label: "IA" },
  { to: "/settings/quick-replies", label: "Respostas rápidas" },
  { to: "/settings/team", label: "Equipe" },
] as const;

export const Route = createFileRoute("/_authenticated/settings")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Configurações — Zap Atende" },
      { name: "description", content: "Configure integração WhatsApp, IA e equipe." },
    ],
  }),
  component: SettingsLayout,
});

function SettingsLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="h-full overflow-y-auto bg-background p-4 md:p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight" style={{ fontFamily: "Instrument Serif, serif", fontSize: 40 }}>
            Configurações
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Ajuste sua central de atendimento.</p>
        </div>
        <div className="mb-6 flex flex-wrap gap-1 rounded-2xl border bg-surface p-1">
          {tabs.map((t) => {
            const active = path === t.to || (path === "/settings" && t.to === "/settings/integration");
            return (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "relative rounded-xl px-4 py-2 text-sm font-medium transition-colors",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && (
                  <motion.div layoutId="settings-tab" className="absolute inset-0 rounded-xl bg-accent" transition={{ type: "spring", bounce: 0.2, duration: 0.5 }} />
                )}
                <span className="relative">{t.label}</span>
              </Link>
            );
          })}
        </div>
        <Outlet />
      </div>
    </div>
  );
}
