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

function toJid(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

export const deleteMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ messageId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: msg, error } = await supabase
      .from("messages")
      .select("id, external_id, direction, conversation_id, conversations(contacts(phone))")
      .eq("id", data.messageId)
      .single();
    if (error || !msg) throw new Error("Mensagem não encontrada");
    if (msg.direction !== "out") throw new Error("Só é possível apagar mensagens enviadas por você");

    const phone = (msg as any).conversations?.contacts?.phone as string | undefined;
    if (msg.external_id && phone) {
      const { fetchEvoConfig, evoDeleteMessage } = await import("./whatsapp.server");
      const cfg = await fetchEvoConfig();
      if (cfg) {
        const res = await evoDeleteMessage(cfg, {
          id: msg.external_id,
          remoteJid: toJid(phone),
          fromMe: true,
        });
        if (!res.ok) throw new Error("Falha ao apagar no WhatsApp: " + JSON.stringify(res.data).slice(0, 200));
      }
    }
    await supabase.from("messages").update({ deleted_at: new Date().toISOString(), body: null, media_url: null }).eq("id", data.messageId);
    return { ok: true };
  });

export const editMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    messageId: z.string().uuid(),
    text: z.string().min(1),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: msg, error } = await supabase
      .from("messages")
      .select("id, external_id, direction, type, created_at, conversations(contacts(phone))")
      .eq("id", data.messageId)
      .single();
    if (error || !msg) throw new Error("Mensagem não encontrada");
    if (msg.direction !== "out") throw new Error("Só é possível editar suas mensagens");
    if (msg.type !== "text") throw new Error("Apenas mensagens de texto podem ser editadas");
    const ageMin = (Date.now() - new Date(msg.created_at).getTime()) / 60000;
    if (ageMin > 15) throw new Error("Mensagens só podem ser editadas em até 15 minutos");

    const phone = (msg as any).conversations?.contacts?.phone as string | undefined;
    if (msg.external_id && phone) {
      const { fetchEvoConfig, evoEditMessage } = await import("./whatsapp.server");
      const cfg = await fetchEvoConfig();
      if (cfg) {
        const res = await evoEditMessage(cfg, phone, {
          id: msg.external_id,
          remoteJid: toJid(phone),
          fromMe: true,
        }, data.text);
        if (!res.ok) throw new Error("Falha ao editar no WhatsApp: " + JSON.stringify(res.data).slice(0, 200));
      }
    }
    await supabase.from("messages").update({ body: data.text, edited_at: new Date().toISOString() }).eq("id", data.messageId);
    return { ok: true };
  });

export const forwardMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    messageId: z.string().uuid(),
    targetConversationIds: z.array(z.string().uuid()).min(1),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const { supabase } = context;
    const { data: msg, error } = await supabase
      .from("messages")
      .select("body, media_url, type")
      .eq("id", data.messageId)
      .single();
    if (error || !msg) throw new Error("Mensagem não encontrada");
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const cid of data.targetConversationIds) {
      try {
        const { data: conv } = await supabase
          .from("conversations")
          .select("id, contacts(phone)")
          .eq("id", cid)
          .single();
        if (!conv) throw new Error("Conversa alvo não encontrada");
        const phone = (conv as any).contacts.phone as string;
        const { fetchEvoConfig, evoSendText, evoSendMedia, evoSendAudio } = await import("./whatsapp.server");
        const cfg = await fetchEvoConfig();
        let externalId: string | null = null;
        let status = "pending";
        let errorMessage: string | null = null;
        if (cfg) {
          let result;
          if (msg.type === "text" && msg.body) {
            result = await evoSendText(cfg, phone, msg.body);
          } else if (msg.media_url) {
            if (msg.type === "audio") result = await evoSendAudio(cfg, phone, msg.media_url);
            else if (msg.type === "image" || msg.type === "video" || msg.type === "document") {
              result = await evoSendMedia(cfg, phone, msg.media_url, msg.type, msg.body ?? undefined);
            }
          }
          if (result) {
            if (result.ok) { status = "sent"; externalId = ((result.data as any)?.key?.id as string) ?? null; }
            else { status = "failed"; errorMessage = JSON.stringify(result.data).slice(0, 300); }
          }
        } else {
          status = "failed"; errorMessage = "WhatsApp não configurado";
        }
        await supabase.from("messages").insert({
          conversation_id: cid,
          direction: "out",
          type: msg.type,
          body: msg.body,
          media_url: msg.media_url,
          sent_by: "agent",
          sender_user_id: context.userId,
          external_id: externalId,
          status,
          error_message: errorMessage,
        });
        await supabase.from("conversations").update({
          last_message_at: new Date().toISOString(),
          last_message_preview: msg.body ?? `[${msg.type}]`,
          status: "open",
        }).eq("id", cid);
        results.push({ id: cid, ok: status === "sent", error: errorMessage ?? undefined });
      } catch (e: any) {
        results.push({ id: cid, ok: false, error: e.message });
      }
    }
    return { results };
  });
