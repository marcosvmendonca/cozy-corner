import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getSettings, updateSetting } from "@/lib/settings.functions";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/ai")({
  ssr: false,
  component: AISettings,
});

function AISettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getSettings);
  const updateFn = useServerFn(updateSetting);
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => getFn() });
  const cur = ((data?.ai as any) ?? {}) as any;
  const [prompt, setPrompt] = useState("");
  const [autopilot, setAutopilot] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) { setPrompt(cur.system_prompt ?? ""); setAutopilot(!!cur.autopilot); } /* eslint-disable-next-line */ }, [data]);

  async function save() {
    setSaving(true);
    try {
      await updateFn({ data: { key: "ai", value: { system_prompt: prompt, autopilot } } });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Salvo");
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="bento-card p-6">
      <h2 className="text-lg font-semibold">Agente de IA</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Define a personalidade e as regras do atendente virtual. Ele sugere respostas e pode responder o começo do atendimento automaticamente.
      </p>
      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label>Prompt do sistema</Label>
          <Textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Você é a atendente da loja X. Seja cordial, use emojis com moderação..." />
        </div>
        <div className="flex items-center justify-between rounded-xl border p-3">
          <div>
            <div className="text-sm font-medium">Autopilot inicial</div>
            <div className="text-xs text-muted-foreground">Responder automaticamente a primeira interação. Passa para humano se o cliente pedir.</div>
          </div>
          <Switch checked={autopilot} onCheckedChange={setAutopilot} />
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
        </Button>
      </div>
    </div>
  );
}
