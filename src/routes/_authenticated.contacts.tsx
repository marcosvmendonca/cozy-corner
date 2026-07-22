import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Search, User } from "lucide-react";

export const Route = createFileRoute("/_authenticated/contacts")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Contatos — Zap Atende" },
      { name: "description", content: "Sua base de clientes." },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    supabase.from("contacts").select("*").order("updated_at", { ascending: false }).limit(200).then(({ data }) => setRows(data ?? []));
  }, []);

  const filtered = rows.filter((r) => !q.trim() || (r.name ?? "").toLowerCase().includes(q.toLowerCase()) || r.phone.includes(q));

  return (
    <div className="h-full overflow-y-auto bg-background p-4 md:p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-semibold" style={{ fontFamily: "Instrument Serif, serif", fontSize: 40 }}>Contatos</h1>
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {filtered.map((c) => (
            <div key={c.id} className="bento-card flex items-center gap-3 p-4">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand text-brand-foreground text-sm font-semibold">
                {(c.name ?? c.phone).slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{c.name ?? "Sem nome"}</div>
                <div className="truncate text-xs text-muted-foreground">{c.phone}</div>
              </div>
              <User className="h-4 w-4 text-muted-foreground" />
            </div>
          ))}
          {filtered.length === 0 && <p className="col-span-full text-center text-sm italic text-muted-foreground">Nenhum contato ainda.</p>}
        </div>
      </div>
    </div>
  );
}
