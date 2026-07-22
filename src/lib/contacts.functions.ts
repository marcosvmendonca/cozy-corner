import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const importContactsFromWhatsApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId, _role: "admin",
    });
    if (!isAdmin) throw new Error("Somente admin pode importar contatos");

    const { fetchEvoConfig, evoFindContacts } = await import("@/lib/whatsapp.server");
    const cfg = await fetchEvoConfig();
    if (!cfg) throw new Error("Configure a Evolution API primeiro");
    const res = await evoFindContacts(cfg);
    if (!res.ok) throw new Error("Falha ao buscar contatos: " + JSON.stringify(res.data).slice(0, 200));

    const list = Array.isArray(res.data) ? res.data : [];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let imported = 0, updated = 0, skipped = 0;
    for (const raw of list) {
      const jid: string = raw?.id ?? raw?.remoteJid ?? "";
      if (!jid || jid.includes("@g.us") || jid.includes("@broadcast") || jid === "status@broadcast") { skipped++; continue; }
      const phone = jid.replace(/@.*/, "").replace(/\D/g, "");
      if (!phone || phone.length < 8) { skipped++; continue; }
      const name = raw?.pushName || raw?.name || raw?.notify || null;

      const { data: exist } = await supabaseAdmin.from("contacts").select("id, name").eq("phone", phone).maybeSingle();
      if (exist) {
        if (name && !exist.name) {
          await supabaseAdmin.from("contacts").update({ name }).eq("id", exist.id);
          updated++;
        } else skipped++;
      } else {
        await supabaseAdmin.from("contacts").insert({ phone, name: name ?? phone });
        imported++;
      }
    }
    return { imported, updated, skipped, total: list.length };
  });


export const startConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    phone: z.string().min(8),
    name: z.string().optional(),
    firstMessage: z.string().optional(),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const phone = data.phone.replace(/\D/g, "");

    // upsert contact
    let { data: contact } = await context.supabase.from("contacts").select("id").eq("phone", phone).maybeSingle();
    if (!contact) {
      const ins = await context.supabase.from("contacts").insert({ phone, name: data.name ?? phone }).select("id").single();
      if (ins.error) throw ins.error;
      contact = ins.data;
    }

    // find existing open conversation or create
    let { data: conv } = await context.supabase
      .from("conversations").select("id").eq("contact_id", contact!.id).in("status", ["waiting", "open"]).maybeSingle();
    if (!conv) {
      const ins = await context.supabase.from("conversations").insert({
        contact_id: contact!.id,
        status: "open",
        assigned_agent_id: context.userId,
        last_message_preview: data.firstMessage ?? "Nova conversa",
        last_message_at: new Date().toISOString(),
      }).select("id").single();
      if (ins.error) throw ins.error;
      conv = ins.data;
    }

    return { conversationId: conv!.id };
  });


export const importHistoryFromWhatsApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    days: z.number().int().min(1).max(365).default(30),
    limit: z.number().int().min(10).max(5000).default(1000),
    includeFromMe: z.boolean().default(true),
  }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId, _role: "admin",
    });
    if (!isAdmin) throw new Error("Somente admin pode importar histórico");

    const { fetchEvoConfig, evoFindMessages } = await import("@/lib/whatsapp.server");
    const cfg = await fetchEvoConfig();
    if (!cfg) throw new Error("Configure a Evolution API primeiro");

    const sinceMs = Date.now() - data.days * 24 * 60 * 60 * 1000;
    const sinceSec = Math.floor(sinceMs / 1000);

    // Evolution v2: POST /chat/findMessages/{instance} with { where: {...} }
    // Fallback: try body { }.
    let res = await evoFindMessages(cfg, {
      where: { messageTimestamp: { $gte: sinceSec } },
      limit: data.limit,
    });
    if (!res.ok) {
      res = await evoFindMessages(cfg, { where: {} });
    }
    if (!res.ok) {
      throw new Error("Falha ao buscar mensagens: " + JSON.stringify(res.data).slice(0, 200));
    }

    const payload = res.data as any;
    const rawList: any[] = Array.isArray(payload)
      ? payload
      : (payload?.messages?.records ?? payload?.records ?? payload?.messages ?? payload?.data ?? []);
    if (!Array.isArray(rawList)) throw new Error("Resposta inesperada da Evolution API");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const contactCache = new Map<string, { id: string; name: string | null }>();
    const convCache = new Map<string, string>();
    let messages = 0, conversations = 0, contacts = 0, skipped = 0;

    // sort by timestamp ascending so previews are the latest
    rawList.sort((a, b) => (a?.messageTimestamp ?? 0) - (b?.messageTimestamp ?? 0));

    for (const raw of rawList) {
      const key = raw?.key ?? {};
      const remoteJid: string = key.remoteJid ?? raw?.remoteJid ?? "";
      if (!remoteJid || remoteJid.includes("@g.us") || remoteJid.includes("@broadcast")) { skipped++; continue; }
      const phone = remoteJid.replace(/@.*/, "").replace(/\D/g, "");
      if (!phone || phone.length < 8) { skipped++; continue; }

      const ts = Number(raw?.messageTimestamp ?? 0);
      if (ts && ts * 1000 < sinceMs) { skipped++; continue; }

      const isFromMe = !!key.fromMe;
      if (isFromMe && !data.includeFromMe) { skipped++; continue; }

      const msg = raw?.message ?? {};
      let type: "text" | "image" | "audio" | "video" | "document" = "text";
      let body: string | null = null;
      let mediaUrl: string | null = null;
      if (msg.conversation) body = msg.conversation;
      else if (msg.extendedTextMessage?.text) body = msg.extendedTextMessage.text;
      else if (msg.imageMessage) { type = "image"; body = msg.imageMessage.caption ?? null; mediaUrl = msg.imageMessage.url ?? null; }
      else if (msg.audioMessage) { type = "audio"; mediaUrl = msg.audioMessage.url ?? null; }
      else if (msg.videoMessage) { type = "video"; body = msg.videoMessage.caption ?? null; mediaUrl = msg.videoMessage.url ?? null; }
      else if (msg.documentMessage) { type = "document"; body = msg.documentMessage.fileName ?? null; mediaUrl = msg.documentMessage.url ?? null; }
      else if (raw?.messageType) type = "text";

      // ensure contact
      let contact = contactCache.get(phone);
      if (!contact) {
        const { data: existing } = await supabaseAdmin.from("contacts").select("id, name").eq("phone", phone).maybeSingle();
        if (existing) contact = existing;
        else {
          const pushName = raw?.pushName || null;
          const ins = await supabaseAdmin.from("contacts").insert({ phone, name: pushName ?? phone }).select("id, name").single();
          if (ins.error) { skipped++; continue; }
          contact = ins.data;
          contacts++;
        }
        contactCache.set(phone, contact!);
      }

      // ensure conversation (one open per contact)
      let convId = convCache.get(contact!.id);
      if (!convId) {
        const { data: existingConv } = await supabaseAdmin.from("conversations")
          .select("id").eq("contact_id", contact!.id).in("status", ["waiting", "open"]).maybeSingle();
        if (existingConv) convId = existingConv.id;
        else {
          const ins = await supabaseAdmin.from("conversations").insert({
            contact_id: contact!.id,
            status: "waiting",
            last_message_preview: body ?? `[${type}]`,
            last_message_at: new Date(ts ? ts * 1000 : Date.now()).toISOString(),
          }).select("id").single();
          if (ins.error) { skipped++; continue; }
          convId = ins.data.id;
          conversations++;
        }
        convCache.set(contact!.id, convId!);
      }

      // dedupe by external_id
      const externalId = key.id ?? null;
      if (externalId) {
        const { data: dup } = await supabaseAdmin.from("messages").select("id").eq("external_id", externalId).maybeSingle();
        if (dup) { skipped++; continue; }
      }

      const ins = await supabaseAdmin.from("messages").insert({
        conversation_id: convId,
        direction: isFromMe ? "out" : "in",
        type,
        body,
        media_url: mediaUrl,
        sent_by: isFromMe ? "agent" : "customer",
        external_id: externalId,
        status: isFromMe ? "sent" : "received",
        created_at: ts ? new Date(ts * 1000).toISOString() : undefined,
      });
      if (ins.error) { skipped++; continue; }
      messages++;

      // update conversation preview to latest
      await supabaseAdmin.from("conversations").update({
        last_message_at: new Date(ts ? ts * 1000 : Date.now()).toISOString(),
        last_message_preview: body ?? `[${type}]`,
      }).eq("id", convId!);
    }

    return { messages, conversations, contacts, skipped, total: rawList.length };
  });
