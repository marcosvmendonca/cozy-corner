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
