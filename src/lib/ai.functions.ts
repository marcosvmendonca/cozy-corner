import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-3-flash-preview";

async function callAI(messages: Array<{ role: string; content: string }>, opts?: { json?: boolean }) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY ausente");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function loadConversation(supabase: any, conversationId: string) {
  const { data: conv } = await supabase
    .from("conversations").select("id, contacts(name, phone, extracted_data)").eq("id", conversationId).single();
  const { data: msgs } = await supabase
    .from("messages").select("direction, body, type, sent_by, created_at").eq("conversation_id", conversationId).order("created_at").limit(40);
  const { data: settings } = await supabase
    .from("settings").select("value").eq("key", "ai").maybeSingle();
  return { conv, msgs: msgs ?? [], ai: (settings?.value ?? {}) as Record<string, any> };
}

function toChat(msgs: Array<{ direction: string; body: string | null; type: string }>): Array<{ role: string; content: string }> {
  return msgs.map((m) => ({
    role: m.direction === "in" ? "user" : "assistant",
    content: m.body ?? `[${m.type}]`,
  }));
}

export const suggestReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { conv, msgs, ai } = await loadConversation(context.supabase, data.conversationId);
    const sys = (ai.system_prompt as string) ?? "Você é um atendente cordial. Responda em português breve.";
    const contact = (conv as any)?.contacts;
    const messages = [
      { role: "system", content: `${sys}\n\nContato: ${contact?.name ?? "desconhecido"} (${contact?.phone}).\nSugira UMA resposta pronta em português para o atendente enviar agora. Não coloque aspas. Não use "Aqui está:". Apenas o texto da resposta.` },
      ...toChat(msgs),
    ];
    const text = await callAI(messages);
    return { text: text.trim() };
  });

export const summarizeConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { conv, msgs } = await loadConversation(context.supabase, data.conversationId);
    const messages = [
      { role: "system", content: `Resuma a conversa em 3 frases curtas em português. Depois extraia dados do cliente em JSON. Responda APENAS um JSON válido com o formato: {"summary": "...", "data": {"name": "...", "email": "...", "intent": "...", "tags": ["..."]}}. Use null quando não souber.` },
      { role: "user", content: msgs.map((m) => `${m.direction === "in" ? "Cliente" : "Atendente"}: ${m.body ?? `[${m.type}]`}`).join("\n") },
    ];
    const raw = await callAI(messages, { json: true });
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = { summary: raw }; }

    // save
    await context.supabase.from("conversations").update({ ai_summary: parsed.summary ?? null }).eq("id", data.conversationId);
    if (parsed.data && (conv as any)?.contacts) {
      const contactId = (await context.supabase.from("conversations").select("contact_id").eq("id", data.conversationId).single()).data?.contact_id;
      if (contactId) {
        await context.supabase.from("contacts").update({
          extracted_data: parsed.data,
          name: parsed.data.name ?? undefined,
          email: parsed.data.email ?? undefined,
        }).eq("id", contactId);
      }
    }
    return parsed;
  });

export const autoReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ conversationId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { conv, msgs, ai } = await loadConversation(context.supabase, data.conversationId);
    const sys = (ai.system_prompt as string) ?? "Você é um atendente cordial.";
    const messages = [
      { role: "system", content: `${sys}\n\nResponda a próxima mensagem do cliente de forma curta e útil. Se o cliente pedir um humano ou o assunto for sensível/reclamação, responda exatamente com [HANDOFF] e nada mais.` },
      ...toChat(msgs),
    ];
    const text = (await callAI(messages)).trim();
    if (text.includes("[HANDOFF]")) {
      await context.supabase.from("conversations").update({ ai_enabled: false, status: "waiting" }).eq("id", data.conversationId);
      return { handoff: true };
    }
    return { text };
  });
