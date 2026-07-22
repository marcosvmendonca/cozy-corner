import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listFlows = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("flows").select("id, name, description, is_active, updated_at").order("updated_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

export const getFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase.from("flows").select("*").eq("id", data.id).single();
    if (error) throw error;
    return row;
  });

export const createFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ name: z.string().min(1) }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("flows").insert({ name: data.name, created_by: context.userId, graph: { nodes: [], edges: [] } })
      .select().single();
    if (error) throw error;
    return row;
  });

const SaveInput = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }),
});

export const saveFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveInput.parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("flows").update({
        name: data.name,
        description: data.description,
        graph: data.graph,
      }).eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const setActiveFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    if (data.active) {
      await context.supabase.from("flows").update({ is_active: false }).neq("id", data.id);
    }
    const { error } = await context.supabase.from("flows").update({ is_active: data.active }).eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const deleteFlow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("flows").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
