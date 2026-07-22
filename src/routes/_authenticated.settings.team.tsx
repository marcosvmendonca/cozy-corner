import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/team")({
  ssr: false,
  component: TeamSettings,
});

function TeamSettings() {
  const [rows, setRows] = useState<Array<{ id: string; full_name: string | null; email: string | null; role: string | null }>>([]);
  const [meAdmin, setMeAdmin] = useState(false);

  async function load() {
    const [{ data: profiles }, { data: roles }, { data: me }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, email"),
      supabase.from("user_roles").select("user_id, role"),
      supabase.auth.getUser(),
    ]);
    const roleMap = new Map<string, string>();
    for (const r of roles ?? []) roleMap.set(r.user_id, r.role);
    setRows((profiles ?? []).map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, role: roleMap.get(p.id) ?? null })));
    if (me.user) setMeAdmin(roleMap.get(me.user.id) === "admin");
  }
  useEffect(() => { load(); }, []);

  async function toggleAdmin(userId: string, current: string | null) {
    if (!meAdmin) return toast.error("Só admins podem alterar");
    if (current === "admin") {
      await supabase.from("user_roles").delete().eq("user_id", userId).eq("role", "admin");
      await supabase.from("user_roles").upsert({ user_id: userId, role: "agent" });
    } else {
      await supabase.from("user_roles").upsert({ user_id: userId, role: "admin" });
    }
    load();
  }

  return (
    <div className="bento-card p-6">
      <div className="mb-4 flex items-center gap-2">
        <Users className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Equipe</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Novos atendentes se cadastram pela tela de login. O primeiro cadastro vira admin automaticamente. Admins podem promover outros.
      </p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-xl border p-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-brand text-brand-foreground text-sm font-semibold">
              {(r.full_name ?? r.email ?? "?").slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.full_name ?? "Sem nome"}</div>
              <div className="truncate text-xs text-muted-foreground">{r.email}</div>
            </div>
            {r.role === "admin" ? <Badge className="rounded-full"><ShieldCheck className="mr-1 h-3 w-3" /> Admin</Badge> : <Badge variant="outline" className="rounded-full">Atendente</Badge>}
            {meAdmin && <Button size="sm" variant="outline" onClick={() => toggleAdmin(r.id, r.role)}>{r.role === "admin" ? "Rebaixar" : "Promover"}</Button>}
          </div>
        ))}
      </div>
    </div>
  );
}
