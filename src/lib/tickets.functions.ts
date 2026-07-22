import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Aceita um ticket em "aguardando": vira responsável e coloca em uma fila.
 */
export const acceptTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({
    conversationId: z.string().uuid(),
    queueId: z.string().uuid(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("conversations")
      .update({
        assigned_agent_id: context.userId,
        queue_id: data.queueId,
        status: "open",
        accepted_at: new Date().toISOString(),
      })
      .eq("id", data.conversationId);
    if (error) throw error;
    return { ok: true };
  });

/**
 * Transfere ticket para outra fila e opcionalmente outro atendente.
 */
export const transferTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({
    conversationId: z.string().uuid(),
    queueId: z.string().uuid().nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    const upd: { queue_id?: string | null; assigned_agent_id?: string | null } = {};
    if (data.queueId !== undefined) upd.queue_id = data.queueId;
    if (data.agentId !== undefined) upd.assigned_agent_id = data.agentId;
    const { error } = await context.supabase
      .from("conversations")
      .update(upd)
      .eq("id", data.conversationId);
    if (error) throw error;
    return { ok: true };
  });


/**
 * Resolver / reabrir ticket.
 */
export const setTicketStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({
    conversationId: z.string().uuid(),
    status: z.enum(["waiting", "open", "resolved"]),
  }).parse(i))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("conversations").update({ status: data.status })
      .eq("id", data.conversationId);
    if (error) throw error;
    return { ok: true };
  });

/**
 * IA sugere para qual fila o ticket deve ir, com base na conversa e nas descrições das filas.
 */
export const suggestQueueForTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ conversationId: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    const { data: queues } = await context.supabase
      .from("queues").select("id, name, description");
    if (!queues || queues.length === 0) return { queueId: null, reason: "Nenhuma fila cadastrada" };

    const { data: msgs } = await context.supabase
      .from("messages").select("direction, body, type")
      .eq("conversation_id", data.conversationId)
      .order("created_at").limit(20);

    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY ausente");

    const transcript = (msgs ?? []).map((m: any) =>
      `${m.direction === "in" ? "Cliente" : "Atendente"}: ${m.body ?? `[${m.type}]`}`
    ).join("\n");

    const queueList = queues.map((q) => `- ${q.name} (id=${q.id}): ${q.description ?? "sem descrição"}`).join("\n");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `Você classifica atendimentos em uma das filas listadas. Responda APENAS JSON: {"queue_id": "<id-ou-null>", "reason": "<motivo curto>"}. Escolha null se nenhuma fila for adequada.\n\nFilas disponíveis:\n${queueList}` },
          { role: "user", content: transcript || "(sem mensagens ainda)" },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const j = await res.json();
    let parsed: { queue_id: string | null; reason: string } = { queue_id: null, reason: "" };
    try { parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}"); } catch { /* noop */ }
    const valid = queues.find((q) => q.id === parsed.queue_id);
    return { queueId: valid?.id ?? null, queueName: valid?.name ?? null, reason: parsed.reason ?? "" };
  });
