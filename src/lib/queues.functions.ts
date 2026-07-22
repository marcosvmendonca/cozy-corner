import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listQueues = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("queues")
      .select("id, name, color, description")
      .order("name");
    if (error) throw error;
    return data ?? [];
  });

export const listAllQueuesAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId, _role: "admin",
    });
    if (!isAdmin) throw new Error("Somente admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: queues } = await supabaseAdmin.from("queues").select("*").order("name");
    const { data: members } = await supabaseAdmin.from("queue_members").select("queue_id, user_id");
    const { data: profiles } = await supabaseAdmin.from("profiles").select("id, full_name, email");
    return { queues: queues ?? [], members: members ?? [], profiles: profiles ?? [] };
  });

export const createQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({
    name: z.string().min(1),
    color: z.string().default("#2f6b4a"),
    description: z.string().optional(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    const { data: r, error } = await context.supabase.from("queues").insert(data).select("*").single();
    if (error) throw error;
    return r;
  });

export const updateQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    color: z.string().optional(),
    description: z.string().nullable().optional(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    const { id, ...upd } = data;
    const { error } = await context.supabase.from("queues").update(upd).eq("id", id);
    if (error) throw error;
    return { ok: true };
  });

export const deleteQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("queues").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const setQueueMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({
    queueId: z.string().uuid(),
    userId: z.string().uuid(),
    enabled: z.boolean(),
  }).parse(i))
  .handler(async ({ context, data }) => {
    if (data.enabled) {
      const { error } = await context.supabase.from("queue_members")
        .upsert({ queue_id: data.queueId, user_id: data.userId });
      if (error) throw error;
    } else {
      const { error } = await context.supabase.from("queue_members")
        .delete().eq("queue_id", data.queueId).eq("user_id", data.userId);
      if (error) throw error;
    }
    return { ok: true };
  });
