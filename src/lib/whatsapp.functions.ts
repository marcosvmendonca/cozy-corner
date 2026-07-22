import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireAdmin(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase
    .from("user_roles").select("role").eq("user_id", ctx.userId).eq("role", "admin");
  if (!data || data.length === 0) throw new Error("Somente admin");
}

export const getWhatsAppQR = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { fetchEvoConfig, evoConnect } = await import("./whatsapp.server");
    const cfg = await fetchEvoConfig();
    if (!cfg) throw new Error("Configure primeiro a Evolution API em Configurações → Integração");
    const { conn } = await evoConnect(cfg);
    const d = conn.data as any;
    // Evolution returns { base64, code, count } (varies by version)
    const qr = d?.base64 ?? d?.qrcode?.base64 ?? d?.qr ?? null;
    const pairingCode = d?.pairingCode ?? d?.code ?? null;
    return { qr: (qr as string | null), pairingCode: (pairingCode as string | null) };
  });

export const getWhatsAppStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    const { fetchEvoConfig, evoStatus } = await import("./whatsapp.server");
    const cfg = await fetchEvoConfig();
    if (!cfg) return { configured: false, state: null as string | null };
    const s = await evoStatus(cfg);
    const state = ((s.data as any)?.instance?.state ?? (s.data as any)?.state ?? null) as string | null;
    return { configured: true, state };
  });

export const registerWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ webhookUrl: z.string().url() }).parse(input))
  .handler(async ({ context, data }) => {
    await requireAdmin(context);
    const { fetchEvoConfig, evoSetWebhook } = await import("./whatsapp.server");
    const cfg = await fetchEvoConfig();
    if (!cfg) throw new Error("Configure a Evolution API primeiro");
    const r = await evoSetWebhook(cfg, data.webhookUrl);
    return { ok: r.ok, status: r.status };
  });

const SendInput = z.object({
  conversationId: z.string().uuid(),
  text: z.string().optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(["image", "video", "document", "audio"]).optional(),
  fileName: z.string().optional(),
});

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SendInput.parse(input))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("id, contact_id, contacts(phone)")
      .eq("id", data.conversationId)
      .single();
    if (convErr || !conv) throw new Error("Conversa não encontrada");
    const phone = (conv as any).contacts.phone as string;

    const { fetchEvoConfig, evoSendText, evoSendMedia, evoSendAudio } = await import("./whatsapp.server");
    const cfg = await fetchEvoConfig();

    let externalId: string | null = null;
    let status = "pending";
    let errorMessage: string | null = null;
    let type: "text" | "image" | "video" | "audio" | "document" = "text";

    if (cfg) {
      let result;
      if (data.mediaUrl && data.mediaType) {
        type = data.mediaType;
        if (data.mediaType === "audio") result = await evoSendAudio(cfg, phone, data.mediaUrl);
        else result = await evoSendMedia(cfg, phone, data.mediaUrl, data.mediaType, data.text, data.fileName);
      } else if (data.text) {
        result = await evoSendText(cfg, phone, data.text);
      }
      if (result) {
        if (result.ok) {
          status = "sent";
          externalId = ((result.data as any)?.key?.id as string) ?? null;
        } else {
          status = "failed";
          errorMessage = JSON.stringify(result.data).slice(0, 500);
        }
      }
    } else {
      status = "failed";
      errorMessage = "WhatsApp não configurado";
    }

    const { data: msg, error: msgErr } = await supabase
      .from("messages")
      .insert({
        conversation_id: data.conversationId,
        direction: "out",
        type,
        body: data.text ?? null,
        media_url: data.mediaUrl ?? null,
        sent_by: "agent",
        sender_user_id: userId,
        external_id: externalId,
        status,
        error_message: errorMessage,
      })
      .select()
      .single();
    if (msgErr) throw msgErr;

    // update conversation
    await supabase
      .from("conversations")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: data.text ?? `[${type}]`,
        status: "open",
        assigned_agent_id: userId,
      })
      .eq("id", data.conversationId);

    return { message: msg, sent: status === "sent", errorMessage };
  });

export const uploadMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    filename: z.string(),
    contentType: z.string(),
    dataUrl: z.string(), // data:<mime>;base64,<...>
  }).parse(input))
  .handler(async ({ context, data }) => {
    const match = data.dataUrl.match(/^data:([^,]*?);base64,(.+)$/);
    if (!match) throw new Error("Formato inválido");
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    const path = `agents/${context.userId}/${Date.now()}-${data.filename}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.storage.from("whatsapp-media").upload(path, bytes, {
      contentType: data.contentType,
      upsert: false,
    });
    if (error) throw error;
    const { data: signed } = await supabaseAdmin.storage.from("whatsapp-media").createSignedUrl(path, 60 * 60 * 24 * 7);
    return { path, url: signed?.signedUrl };
  });
