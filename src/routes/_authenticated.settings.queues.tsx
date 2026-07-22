import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  listAllQueuesAdmin, createQueue, updateQueue, deleteQueue, setQueueMember,
} from "@/lib/queues.functions";
import { Loader2, Plus, Trash2, Users } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/queues")({
  ssr: false,
  component: QueuesSettings,
});

function QueuesSettings() {
  const qc = useQueryClient();
  const listFn = useServerFn(listAllQueuesAdmin);
  const createFn = useServerFn(createQueue);
  const updFn = useServerFn(updateQueue);
  const delFn = useServerFn(deleteQueue);
  const memberFn = useServerFn(setQueueMember);

  const { data, isLoading, error } = useQuery({
    queryKey: ["queues-admin"],
    queryFn: () => listFn(),
    retry: false,
  });

  const [form, setForm] = useState({ name: "", color: "#2f6b4a", description: "" });

  const createMut = useMutation({
    mutationFn: async () => createFn({ data: form }),
    onSuccess: () => {
      toast.success("Fila criada");
      setForm({ name: "", color: "#2f6b4a", description: "" });
      qc.invalidateQueries({ queryKey: ["queues-admin"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (error) {
    return <div className="bento-card p-6 text-sm text-muted-foreground">Somente admins acessam a gestão de filas.</div>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
      <motion.div layout className="bento-card p-6">
        <h2 className="text-lg font-semibold">Nova fila</h2>
        <p className="mt-1 text-xs text-muted-foreground">Filas organizam tickets por área (ex: Vendas, Suporte).</p>
        <form
          onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) createMut.mutate(); }}
          className="mt-4 space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Nome</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Atendimento Geral" />
          </div>
          <div className="space-y-1.5">
            <Label>Cor</Label>
            <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="h-10 w-full rounded-lg border" />
          </div>
          <div className="space-y-1.5">
            <Label>Descrição (usada pela IA para rotear)</Label>
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Ex: dúvidas de pré-venda, orçamentos e novos leads" />
          </div>
          <Button type="submit" className="w-full" disabled={createMut.isPending || !form.name.trim()}>
            {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="mr-1 h-4 w-4" /> Criar fila</>}
          </Button>
        </form>
      </motion.div>

      <div className="space-y-3">
        {isLoading && <div className="bento-card p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>}
        {data?.queues.length === 0 && (
          <div className="bento-card p-6 text-sm text-muted-foreground">Nenhuma fila ainda. Crie a primeira ao lado.</div>
        )}
        {data?.queues.map((q) => (
          <QueueCard
            key={q.id}
            queue={q}
            profiles={data.profiles}
            members={data.members.filter((m) => m.queue_id === q.id).map((m) => m.user_id)}
            onSave={async (patch) => { await updFn({ data: { id: q.id, ...patch } }); qc.invalidateQueries({ queryKey: ["queues-admin"] }); }}
            onDelete={async () => { if (!confirm(`Apagar fila "${q.name}"?`)) return; await delFn({ data: { id: q.id } }); toast.success("Fila apagada"); qc.invalidateQueries({ queryKey: ["queues-admin"] }); }}
            onToggleMember={async (userId, enabled) => { await memberFn({ data: { queueId: q.id, userId, enabled } }); qc.invalidateQueries({ queryKey: ["queues-admin"] }); }}
          />
        ))}
      </div>
    </div>
  );
}

function QueueCard({ queue, profiles, members, onSave, onDelete, onToggleMember }: {
  queue: { id: string; name: string; color: string; description: string | null };
  profiles: Array<{ id: string; full_name: string | null; email: string | null }>;
  members: string[];
  onSave: (patch: { name?: string; color?: string; description?: string | null }) => Promise<void>;
  onDelete: () => Promise<void>;
  onToggleMember: (userId: string, enabled: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(queue.name);
  const [color, setColor] = useState(queue.color);
  const [description, setDescription] = useState(queue.description ?? "");
  const dirty = name !== queue.name || color !== queue.color || (description || "") !== (queue.description || "");

  return (
    <motion.div layout className="bento-card p-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 h-8 w-8 shrink-0 rounded-xl" style={{ backgroundColor: color }} />
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs font-semibold" />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border" />
            <Badge variant="outline" className="rounded-full"><Users className="mr-1 h-3 w-3" /> {members.length}</Badge>
            <div className="ml-auto flex gap-2">
              {dirty && (
                <Button size="sm" onClick={() => onSave({ name, color, description })}>Salvar</Button>
              )}
              <Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descrição usada pela IA para decidir a fila" />
        </div>
      </div>
      <div className="mt-4 border-t pt-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Membros</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {profiles.map((p) => {
            const on = members.includes(p.id);
            return (
              <label key={p.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
                <Switch checked={on} onCheckedChange={(v) => onToggleMember(p.id, v)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{p.full_name ?? p.email ?? p.id}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{p.email}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
