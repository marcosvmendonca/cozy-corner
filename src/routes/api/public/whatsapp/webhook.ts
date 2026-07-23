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

        // Read receipts / delivery / send acks from Evolution
        // status codes: 0/1 pending, 2 sent (server ack), 3 delivered, 4 read, 5 played
        if (event === "messages.update" || event === "messages_update") {
          const items = Array.isArray(payload?.data) ? payload.data : [payload?.data].filter(Boolean);
          for (const raw of items) {
            const key = raw?.key ?? {};
            const externalId: string | null =
              key?.id ?? raw?.keyId ?? raw?.messageId ?? raw?.key_id ?? null;
            if (!externalId) continue;
            const s = raw?.update?.status ?? raw?.status ?? raw?.messageStatus ?? null;
            const norm = typeof s === "string" ? s.toUpperCase() : s;
            let statusStr: string | null = null;
            if (norm === 2 || norm === "SERVER_ACK" || norm === "SENT") statusStr = "sent";
            else if (norm === 3 || norm === "DELIVERY_ACK" || norm === "DELIVERED") statusStr = "delivered";
            else if (norm === 4 || norm === "READ" || norm === "PLAYED" || norm === 5) statusStr = "read";
            else if (typeof norm === "string") {
              const l = norm.toLowerCase();
              if (["sent", "delivered", "read"].includes(l)) statusStr = l;
            }
            if (!statusStr) continue;
            await supabaseAdmin.from("messages").update({ status: statusStr }).eq("external_id", externalId);
          }
          return jsonOk();
        }

        // Message edits — Evolution emits either "messages.edited" or a protocolMessage inside upsert
        if (event === "messages.edited" || event === "messages_edited" || event === "messages.edit") {
          const items = Array.isArray(payload?.data) ? payload.data : [payload?.data].filter(Boolean);
          for (const raw of items) {
            const editedId = raw?.key?.id ?? raw?.editedMessageId ?? raw?.message?.protocolMessage?.key?.id ?? null;
            const newText: string | null =
              raw?.message?.editedMessage?.message?.conversation ??
              raw?.message?.editedMessage?.message?.extendedTextMessage?.text ??
              raw?.message?.protocolMessage?.editedMessage?.conversation ??
              raw?.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text ??
              raw?.editedText ?? raw?.text ?? null;
            if (!editedId || !newText) continue;
            await supabaseAdmin.from("messages")
              .update({ body: newText, edited_at: new Date().toISOString() })
              .eq("external_id", editedId);
          }
          return jsonOk();
        }

        if (event === "messages.upsert" || event === "messages_upsert") {
          const items = Array.isArray(payload?.data) ? payload.data : [payload?.data].filter(Boolean);
          for (const raw of items) {
            const key = raw?.key ?? {};
            const isFromMe = !!key.fromMe;
            const remoteJid: string = key.remoteJid ?? "";
            const phone = remoteJid.replace(/@.*/, "").replace(/\D/g, "");
            if (!phone || remoteJid.includes("@g.us")) continue; // skip groups

            const msg = raw?.message ?? {};
            const pushName: string | undefined = raw?.pushName;

            // Edit arriving as protocolMessage inside upsert
            const proto = msg?.protocolMessage;
            if (proto?.editedMessage || proto?.type === 14 || proto?.type === "MESSAGE_EDIT") {
              const editedId = proto?.key?.id;
              const newText: string | null =
                proto?.editedMessage?.conversation ??
                proto?.editedMessage?.extendedTextMessage?.text ??
                proto?.editedMessage?.message?.conversation ??
                proto?.editedMessage?.message?.extendedTextMessage?.text ?? null;
              if (editedId && newText) {
                await supabaseAdmin.from("messages")
                  .update({ body: newText, edited_at: new Date().toISOString() })
                  .eq("external_id", editedId);
              }
              continue;
            }


            let type: "text" | "image" | "audio" | "video" | "document" | "sticker" = "text";
            let body: string | null = null;
            let mediaUrl: string | null = null;
            if (msg.conversation) { body = msg.conversation; }
            else if (msg.extendedTextMessage?.text) { body = msg.extendedTextMessage.text; }
            else if (msg.stickerMessage) { type = "sticker"; mediaUrl = msg.stickerMessage.url ?? null; }
            else if (msg.imageMessage) { type = "image"; body = msg.imageMessage.caption ?? null; mediaUrl = msg.imageMessage.url ?? null; }
            else if (msg.audioMessage) { type = "audio"; mediaUrl = msg.audioMessage.url ?? null; }
            else if (msg.videoMessage) { type = "video"; body = msg.videoMessage.caption ?? null; mediaUrl = msg.videoMessage.url ?? null; }
            else if (msg.documentMessage) { type = "document"; body = msg.documentMessage.fileName ?? null; mediaUrl = msg.documentMessage.url ?? null; }

            // Deduplicate: if we already have this external_id, skip (echo of our own send).
            if (key?.id) {
              const { data: existing } = await supabaseAdmin
                .from("messages").select("id").eq("external_id", key.id).maybeSingle();
              if (existing) continue;
            }

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
                status: isFromMe ? "open" : "waiting",
                last_message_preview: body ?? `[${type}]`,
                last_message_at: new Date().toISOString(),
              }).select("id, ai_enabled").single();
              conv = ins.data;
            }

            await supabaseAdmin.from("messages").insert({
              conversation_id: conv!.id,
              direction: isFromMe ? "out" : "in",
              type,
              body,
              media_url: mediaUrl,
              sent_by: isFromMe ? "agent" : "customer",
              external_id: key.id ?? null,
              status: isFromMe ? "sent" : "received",
            });

            await supabaseAdmin.from("conversations").update({
              last_message_at: new Date().toISOString(),
              last_message_preview: body ?? `[${type}]`,
            }).eq("id", conv!.id);
          }
        }

        return jsonOk();
      },
      GET: async () => new Response("ok"),
    },
  },
});

function jsonOk() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
