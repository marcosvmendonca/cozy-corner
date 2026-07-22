import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getSettings, updateSetting } from "@/lib/settings.functions";
import { getWhatsAppQR, getWhatsAppStatus, registerWebhook } from "@/lib/whatsapp.functions";
import { importContactsFromWhatsApp } from "@/lib/contacts.functions";
import { Loader2, QrCode, CheckCircle2, XCircle, RefreshCw, Copy, Download } from "lucide-react";


export const Route = createFileRoute("/_authenticated/settings/integration")({
  ssr: false,
  component: IntegrationSettings,
});

function IntegrationSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getSettings);
  const updateFn = useServerFn(updateSetting);
  const qrFn = useServerFn(getWhatsAppQR);
  const statusFn = useServerFn(getWhatsAppStatus);
  const webhookFn = useServerFn(registerWebhook);
  const importFn = useServerFn(importContactsFromWhatsApp);


  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => getFn() });

  const wa = ((settings?.whatsapp as any) ?? {}) as { base_url?: string; api_key?: string; instance_name?: string; webhook_secret?: string };
  const [form, setForm] = useState({ base_url: "", api_key: "", instance_name: "", webhook_secret: "" });
  useEffect(() => { if (settings) setForm({ base_url: wa.base_url ?? "", api_key: wa.api_key ?? "", instance_name: wa.instance_name ?? "", webhook_secret: wa.webhook_secret ?? "" }); /* eslint-disable-next-line */ }, [settings]);

  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [statusState, setStatusState] = useState<string | null>(null);
  const [loading, setLoading] = useState<null | "save" | "qr" | "status" | "hook" | "import">(null);

  // Evolution API precisa de uma URL estável e acessível sem autenticação.
  // O host de sandbox (`*.lovableproject.com` / `id-preview--*`) redireciona por auth-bridge
  // e devolve 302, então o webhook nunca chega. Sempre usamos o host estável de preview.
  const webhookUrl = (() => {
    if (typeof window === "undefined") return "";
    const host = window.location.hostname;
    const m = host.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const projectId = m?.[1];
    if (projectId) {
      return `https://project--${projectId}-dev.lovable.app/api/public/whatsapp/webhook`;
    }
    return `${window.location.origin}/api/public/whatsapp/webhook`;
  })();

  async function refreshStatus() {
    setLoading("status");
    try {
      const s = await statusFn();
      setStatusState(s.state);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(null); }
  }
  useEffect(() => { if (settings?.whatsapp) refreshStatus(); /* eslint-disable-next-line */ }, [settings]);
  // poll while QR shown
  useEffect(() => {
    if (!qr) return;
    const i = setInterval(refreshStatus, 4000);
    return () => clearInterval(i);
  }, [qr]);
  useEffect(() => { if (statusState === "open" || statusState === "connected") setQr(null); }, [statusState]);

  async function save() {
    setLoading("save");
    try {
      await updateFn({ data: { key: "whatsapp", value: form } });
      toast.success("Salvo");
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e: any) { toast.error(e.message); } finally { setLoading(null); }
  }

  async function generateQR() {
    setLoading("qr");
    setQr(null); setPairingCode(null);
    try {
      const r = await qrFn();
      setQr(r.qr);
      setPairingCode(r.pairingCode);
      if (!r.qr && !r.pairingCode) toast.info("Instância já conectada ou aguardando");
    } catch (e: any) { toast.error(e.message); } finally { setLoading(null); }
  }

  async function setupWebhook() {
    setLoading("hook");
    try {
      await webhookFn({ data: { webhookUrl } });
      toast.success("Webhook configurado na Evolution API");
    } catch (e: any) { toast.error(e.message); } finally { setLoading(null); }
  }

  async function importContacts() {
    setLoading("import");
    try {
      const r = await importFn();
      toast.success(`Importados: ${r.imported} · atualizados: ${r.updated} · ignorados: ${r.skipped}`);
    } catch (e: any) { toast.error(e.message); } finally { setLoading(null); }
  }


  const connected = statusState === "open" || statusState === "connected";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <motion.div layout className="bento-card p-6">
        <h2 className="text-lg font-semibold">Evolution API</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Servidor externo Evolution API (Baileys). Preencha URL, chave e nome da instância.
        </p>
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label>URL base</Label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://evolution.seu-dominio.com" />
            </div>
            <div className="space-y-1.5">
              <Label>API Key</Label>
              <Input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sua-chave" />
            </div>
            <div className="space-y-1.5">
              <Label>Nome da instância</Label>
              <Input value={form.instance_name} onChange={(e) => setForm({ ...form, instance_name: e.target.value })} placeholder="minha-empresa" />
            </div>
            <Button onClick={save} disabled={loading === "save"} className="w-full">
              {loading === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
            </Button>
          </div>
        )}
      </motion.div>

      <motion.div layout className="bento-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Conexão</h2>
          <Button variant="ghost" size="icon" onClick={refreshStatus} disabled={loading === "status"}>
            <RefreshCw className={"h-4 w-4 " + (loading === "status" ? "animate-spin" : "")} />
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-xl border p-3">
          {connected ? <CheckCircle2 className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-muted-foreground" />}
          <div>
            <div className="text-sm font-medium">{connected ? "Conectado" : "Desconectado"}</div>
            <div className="text-xs text-muted-foreground">Estado: {statusState ?? "—"}</div>
          </div>
        </div>

        <Button variant="outline" onClick={generateQR} disabled={loading === "qr"} className="mt-4 w-full">
          {loading === "qr" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <QrCode className="mr-2 h-4 w-4" />}
          Gerar QR / Código de pareamento
        </Button>

        {qr && (
          <div className="mt-4 rounded-2xl border p-4 text-center">
            <img src={qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`} alt="QR Code" className="mx-auto max-w-[240px]" />
            <p className="mt-2 text-xs text-muted-foreground">Escaneie no WhatsApp &gt; Aparelhos conectados</p>
          </div>
        )}
        {pairingCode && !qr && (
          <div className="mt-4 rounded-2xl border bg-brand-soft/40 p-4 text-center">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Código de pareamento</div>
            <div className="mt-1 font-mono text-2xl font-bold tracking-widest">{pairingCode}</div>
          </div>
        )}

        <div className="mt-6 border-t pt-4">
          <Label className="text-xs">URL do webhook (aponte da Evolution para cá)</Label>
          <div className="mt-1.5 flex gap-2">
            <Input readOnly value={webhookUrl} className="font-mono text-xs" />
            <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(webhookUrl); toast.success("Copiado"); }}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <Button variant="secondary" size="sm" className="mt-2 w-full" onClick={setupWebhook} disabled={loading === "hook"}>
            {loading === "hook" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Configurar webhook automaticamente
          </Button>
        </div>

        <div className="mt-6 border-t pt-4">
          <Label className="text-xs">Importar contatos do aparelho</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">Traz a lista de contatos do WhatsApp conectado (sem histórico de mensagens).</p>
          <Button variant="outline" size="sm" className="mt-2 w-full" onClick={importContacts} disabled={loading === "import"}>
            {loading === "import" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Importar contatos agora
          </Button>
        </div>

      </motion.div>
    </div>
  );
}
