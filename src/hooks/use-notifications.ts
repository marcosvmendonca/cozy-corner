import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const STORAGE_KEY = "zap.notifications.enabled";

// Simple beep using WebAudio — no asset dependency.
function playBeep() {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.4);
    setTimeout(() => ctx.close(), 600);
  } catch { /* ignore */ }
}

export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem(STORAGE_KEY) !== "0";
  });
  const [unread, setUnread] = useState(0);
  const lastNotifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  }, [enabled]);

  async function requestPermission() {
    if (typeof Notification === "undefined") return "denied" as NotificationPermission;
    const p = await Notification.requestPermission();
    setPermission(p);
    return p;
  }

  useEffect(() => {
    if (!enabled) return;
    const channel = supabase
      .channel("realtime-notify")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: "direction=eq.in" },
        async (payload) => {
          const row = payload.new as { id: string; conversation_id: string; body: string | null; type: string };
          if (lastNotifiedRef.current.has(row.id)) return;
          lastNotifiedRef.current.add(row.id);

          // fetch contact name for a nice title
          const { data: conv } = await supabase
            .from("conversations")
            .select("contact_id, contacts(name, phone)")
            .eq("id", row.conversation_id)
            .maybeSingle();
          const contact = (conv as any)?.contacts;
          const title = contact?.name || contact?.phone || "Nova mensagem";
          const preview = row.body || `[${row.type}]`;

          setUnread((u) => u + 1);

          // In-app toast (always)
          toast(title, {
            description: preview,
            action: {
              label: "Abrir",
              onClick: () => {
                window.location.href = `/inbox?c=${row.conversation_id}`;
              },
            },
          });

          // Browser notification (if allowed and tab hidden)
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted" &&
            document.visibilityState !== "visible"
          ) {
            try {
              const n = new Notification(title, { body: preview, tag: row.conversation_id });
              n.onclick = () => {
                window.focus();
                window.location.href = `/inbox?c=${row.conversation_id}`;
              };
            } catch { /* ignore */ }
          }

          playBeep();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [enabled]);

  // Reset badge on tab focus
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") setUnread(0); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return { permission, requestPermission, enabled, setEnabled, unread, clearUnread: () => setUnread(0) };
}
