import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Trash2, Plus, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/quick-replies")({
  ssr: false,
  component: QuickRepliesSettings,
});

function QuickRepliesSettings() {
  const qc = useQueryClient();
  const { data: replies = [] } = useQuery({
    queryKey: ["quick_replies"],
    queryFn: async () => (await supabase.from("quick_replies").select("*").order("shortcut")).data ?? [],
  });
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");

  async function add() {
    if (!shortcut.trim() || !body.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("quick_replies").insert({ shortcut: shortcut.trim(), body: body.trim(), created_by: u.user!.id });
    if (error) return toast.error(error.message);
    setShortcut(""); setBody("");
    qc.invalidateQueries({ queryKey: ["quick_replies"] });
  }
  async function del(id: string) {
    await supabase.from("quick_replies").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["quick_replies"] });
  }

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
      <div className="bento-card h-fit p-6">
        <h2 className="text-lg font-semibold">Nova resposta rápida</h2>
        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            <Label>Atalho</Label>
            <Input placeholder="oi" value={shortcut} onChange={(e) => setShortcut(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Mensagem</Label>
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <Button onClick={add} className="w-full"><Plus className="mr-1 h-4 w-4" /> Adicionar</Button>
        </div>
      </div>
      <div className="bento-card p-6">
        <h2 className="text-lg font-semibold">Salvas</h2>
        <div className="mt-4 space-y-2">
          {replies.length === 0 && <p className="text-sm italic text-muted-foreground">Nenhuma resposta ainda.</p>}
          {replies.map((r) => (
            <div key={r.id} className="flex items-start gap-3 rounded-xl border p-3">
              <Zap className="mt-0.5 h-4 w-4 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs font-semibold">/{r.shortcut}</div>
                <div className="mt-1 text-sm text-muted-foreground">{r.body}</div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => del(r.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
