import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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
