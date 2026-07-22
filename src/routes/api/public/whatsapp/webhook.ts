import { createFileRoute } from "@tanstack/react-router";

// Public Evolution API webhook. Evolution POSTs message events here.
export const Route = createFileRoute("/api/public/whatsapp/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let payload: any;
        try { payload = await request.json(); } catch { return new Response("bad", { status: 400 }); }

        const event = (payload?.event ?? "").toString().toLowerCase();

        // Log
        await supabaseAdmin.from("webhook_events").insert({ source: "evolution", event, payload });

        if (event === "messages.upsert" || event === "messages_upsert") {
          const items = Array.isArray(payload?.data) ? payload.data : [payload?.data].filter(Boolean);
          for (const raw of items) {
            const key = raw?.key ?? {};
            const isFromMe = !!key.fromMe;
            if (isFromMe) continue; // ignore echo for now
            const remoteJid: string = key.remoteJid ?? "";
            const phone = remoteJid.replace(/@.*/, "").replace(/\D/g, "");
            if (!phone || remoteJid.includes("@g.us")) continue; // skip groups

            const msg = raw?.message ?? {};
            const pushName: string | undefined = raw?.pushName;

            let type: "text" | "image" | "audio" | "video" | "document" = "text";
            let body: string | null = null;
            let mediaUrl: string | null = null;
            if (msg.conversation) { body = msg.conversation; }
            else if (msg.extendedTextMessage?.text) { body = msg.extendedTextMessage.text; }
            else if (msg.imageMessage) { type = "image"; body = msg.imageMessage.caption ?? null; mediaUrl = msg.imageMessage.url ?? null; }
            else if (msg.audioMessage) { type = "audio"; mediaUrl = msg.audioMessage.url ?? null; }
            else if (msg.videoMessage) { type = "video"; body = msg.videoMessage.caption ?? null; mediaUrl = msg.videoMessage.url ?? null; }
            else if (msg.documentMessage) { type = "document"; body = msg.documentMessage.fileName ?? null; mediaUrl = msg.documentMessage.url ?? null; }

            // Upsert contact
            let { data: contact } = await supabaseAdmin.from("contacts").select("id, name").eq("phone", phone).maybeSingle();
            if (!contact) {
              const ins = await supabaseAdmin.from("contacts").insert({ phone, name: pushName ?? phone }).select("id, name").single();
              contact = ins.data;
            } else if (pushName && !contact.name) {
              await supabaseAdmin.from("contacts").update({ name: pushName }).eq("id", contact.id);
            }

            // Find or create open conversation
            let { data: conv } = await supabaseAdmin.from("conversations")
              .select("id, ai_enabled").eq("contact_id", contact!.id).in("status", ["waiting", "open"]).maybeSingle();
            if (!conv) {
              const ins = await supabaseAdmin.from("conversations").insert({
                contact_id: contact!.id,
                status: "waiting",
                last_message_preview: body ?? `[${type}]`,
                last_message_at: new Date().toISOString(),
              }).select("id, ai_enabled").single();
              conv = ins.data;
            }

            await supabaseAdmin.from("messages").insert({
              conversation_id: conv!.id,
              direction: "in",
              type,
              body,
              media_url: mediaUrl,
              sent_by: "customer",
              external_id: key.id ?? null,
              status: "received",
            });

            await supabaseAdmin.from("conversations").update({
              last_message_at: new Date().toISOString(),
              last_message_preview: body ?? `[${type}]`,
            }).eq("id", conv!.id);
          }
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      },
      GET: async () => new Response("ok"),
    },
  },
});
