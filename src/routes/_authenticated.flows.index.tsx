import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { listFlows, createFlow, setActiveFlow, deleteFlow } from "@/lib/flows.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Plus, GitBranch, Trash2, Edit3 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/flows/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Fluxos — Zap Atende" },
      { name: "description", content: "Construa fluxos automatizados de conversa." },
    ],
  }),
  component: FlowsList,
});

function FlowsList() {
  const qc = useQueryClient();
  const listFn = useServerFn(listFlows);
  const createFn = useServerFn(createFlow);
  const toggleFn = useServerFn(setActiveFlow);
  const delFn = useServerFn(deleteFlow);

  const { data: flows = [], isLoading } = useQuery({ queryKey: ["flows"], queryFn: () => listFn() });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createFn({ data: { name } });
      qc.invalidateQueries({ queryKey: ["flows"] });
      setOpen(false); setName("");
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="h-full overflow-y-auto bg-background p-4 md:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold" style={{ fontFamily: "Instrument Serif, serif", fontSize: 40 }}>
              Fluxos
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Construa árvores de decisão automáticas.</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button><Plus className="mr-1 h-4 w-4" /> Novo fluxo</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Novo fluxo</DialogTitle></DialogHeader>
              <Input placeholder="Ex: Boas-vindas" value={name} onChange={(e) => setName(e.target.value)} />
              <DialogFooter>
                <Button onClick={create} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar"}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {flows.map((f, idx) => (
            <motion.div key={f.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.05 }} className="bento-card p-5">
              <div className="flex items-start justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-brand-soft text-brand">
                  <GitBranch className="h-5 w-5" />
                </div>
                <Switch
                  checked={f.is_active}
                  onCheckedChange={async (v) => { await toggleFn({ data: { id: f.id, active: v } }); qc.invalidateQueries({ queryKey: ["flows"] }); }}
                />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{f.name}</h3>
              <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-xs text-muted-foreground">{f.description ?? "Sem descrição"}</p>
              <div className="mt-4 flex gap-2">
                <Button asChild variant="outline" size="sm" className="flex-1">
                  <Link to="/flows/$flowId" params={{ flowId: f.id }}><Edit3 className="mr-1 h-3.5 w-3.5" /> Editar</Link>
                </Button>
                <Button variant="ghost" size="icon" onClick={async () => { if (confirm("Excluir fluxo?")) { await delFn({ data: { id: f.id } }); qc.invalidateQueries({ queryKey: ["flows"] }); } }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
