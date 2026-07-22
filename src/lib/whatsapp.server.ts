// Server-only Evolution API adapter.
// Reads credentials from the `settings` table via a server-only supabase client.

export type EvoConfig = {
  baseUrl: string;
  apiKey: string;
  instance: string;
};

export async function fetchEvoConfig(): Promise<EvoConfig | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("settings").select("value").eq("key", "whatsapp").maybeSingle();
  const v = (data?.value ?? {}) as Record<string, string>;
  if (!v.base_url || !v.api_key || !v.instance_name) return null;
  return { baseUrl: v.base_url.replace(/\/$/, ""), apiKey: v.api_key, instance: v.instance_name };
}

export async function evoRequest(
  cfg: EvoConfig,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      apikey: cfg.apiKey,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

export async function evoConnect(cfg: EvoConfig) {
  // Create instance if needed then fetch QR
  const create = await evoRequest(cfg, `/instance/create`, {
    method: "POST",
    body: {
      instanceName: cfg.instance,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    },
  });
  // ignore create error (may already exist)
  const conn = await evoRequest(cfg, `/instance/connect/${cfg.instance}`, { method: "GET" });
  return { create, conn };
}

export async function evoStatus(cfg: EvoConfig) {
  return evoRequest(cfg, `/instance/connectionState/${cfg.instance}`, { method: "GET" });
}

export async function evoSendText(cfg: EvoConfig, number: string, text: string) {
  return evoRequest(cfg, `/message/sendText/${cfg.instance}`, {
    method: "POST",
    body: { number, text },
  });
}

export async function evoSendMedia(cfg: EvoConfig, number: string, mediaUrl: string, mediatype: "image" | "video" | "document", caption?: string, fileName?: string) {
  return evoRequest(cfg, `/message/sendMedia/${cfg.instance}`, {
    method: "POST",
    body: { number, mediatype, media: mediaUrl, caption, fileName },
  });
}

export async function evoSendAudio(cfg: EvoConfig, number: string, audioUrl: string) {
  // Evolution reencodes to ogg/opus (PTT) when `encoding: true`.
  // Private storage URLs aren't fetchable server-side by Evolution — download and send as base64.
  let audioPayload = audioUrl;
  try {
    const res = await fetch(audioUrl);
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      audioPayload = btoa(bin);
    }
  } catch {
    // fall back to url
  }
  return evoRequest(cfg, `/message/sendWhatsAppAudio/${cfg.instance}`, {
    method: "POST",
    body: { number, audio: audioPayload, encoding: true },
  });
}

export async function evoSetWebhook(cfg: EvoConfig, url: string) {
  return evoRequest(cfg, `/webhook/set/${cfg.instance}`, {
    method: "POST",
    body: {
      webhook: {
        url,
        enabled: true,
        webhookByEvents: false,
        events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"],
      },
    },
  });
}

export async function evoFindContacts(cfg: EvoConfig) {
  return evoRequest(cfg, `/chat/findContacts/${cfg.instance}`, {
    method: "POST",
    body: {},
  });
}


export async function evoFindMessages(cfg: EvoConfig, body: Record<string, unknown> = {}) {
  return evoRequest(cfg, `/chat/findMessages/${cfg.instance}`, {
    method: "POST",
    body,
  });
}

export async function evoFindChats(cfg: EvoConfig) {
  return evoRequest(cfg, `/chat/findChats/${cfg.instance}`, {
    method: "POST",
    body: {},
  });
}
