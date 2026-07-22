import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.from("settings").select("key, value");
    if (error) throw error;
    const map: Record<string, any> = {};
    for (const row of data ?? []) map[row.key] = row.value as any;
    return map as Record<string, any>;
  });

const UpdateInput = z.object({
  key: z.enum(["ai", "whatsapp"]),
  value: z.record(z.any()),
});

export const updateSetting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => UpdateInput.parse(input))
  .handler(async ({ context, data }) => {
    // check admin
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin");
    if (!roles || roles.length === 0) throw new Error("Somente admin pode alterar configurações");

    const { error } = await context.supabase
      .from("settings")
      .update({ value: data.value as any, updated_by: context.userId, updated_at: new Date().toISOString() })
      .eq("key", data.key);
    if (error) throw error;
    return { ok: true };
  });
