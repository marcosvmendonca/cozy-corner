import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { sendMessage, uploadMedia } from "@/lib/whatsapp.functions";
import { suggestReply, summarizeConversation } from "@/lib/ai.functions";
import { startConversation } from "@/lib/contacts.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Search, Send, Sparkles, Plus, Mic, Square, Paperclip, Zap,
  MessageSquare, Loader2, User as UserIcon, PhoneCall, FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Tables } from "@/integrations/supabase/types";

type Conversation = Tables<"conversations"> & { contacts: Tables<"contacts"> };
type Message = Tables<"messages">;

const Search$ = z.object({ c: z.string().uuid().optional() });

export const Route = createFileRoute("/_authenticated/inbox")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Atendimento — Zap Atende" },
      { name: "description", content: "Central de atendimento WhatsApp em tempo real." },
    ],
  }),
  validateSearch: Search$,
  component: InboxPage,
});

function InboxPage() {
  const { c: selectedId } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const qc = useQueryClient();

  const [filter, setFilter] = useState("");

  // Realtime list
  const { data: conversations = [] } = useQuery({
    queryKey: ["conversations"],
    queryFn: async (): Promise<Conversation[]> => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contacts(*)")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as any;
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("realtime-conversations")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        qc.invalidateQueries({ queryKey: ["conversations"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        qc.invalidateQueries({ queryKey: ["conversations"] });
        if (selectedId) qc.invalidateQueries({ queryKey: ["messages", selectedId] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc, selectedId]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return conversations;
    return conversations.filter((c) =>
      (c.contacts?.name ?? "").toLowerCase().includes(f) ||
      c.contacts?.phone?.includes(f) ||
      (c.last_message_preview ?? "").toLowerCase().includes(f),
    );
  }, [conversations, filter]);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const openCount = conversations.filter((c) => c.status === "open").length;
  const waitingCount = conversations.filter((c) => c.status === "waiting").length;

  return (
    <div className="h-full w-full overflow-hidden bg-background p-3 md:p-4">
      <div className="grid h-full grid-cols-1 gap-3 md:grid-cols-[340px_minmax(0,1fr)_320px] md:gap-4">
        {/* LEFT: Conversation list */}
        <motion.div
          layout
          className="bento-card flex min-h-0 flex-col"
        >
          <div className="flex items-center justify-between p-4 pb-3">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Conversas</h2>
              <div className="mt-1 flex gap-2 text-[10px]">
                <Badge variant="secondary" className="rounded-full">
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-brand" />
                  {openCount} abertas
                </Badge>
                <Badge variant="outline" className="rounded-full">{waitingCount} aguardando</Badge>
              </div>
            </div>
            <NewConversationDialog onCreated={(id) => navigate({ search: { c: id } })} />
          </div>
          <div className="px-4 pb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar contato..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-1 px-2 pb-2">
              {filtered.length === 0 && (
                <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                  <MessageSquare className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  Nenhuma conversa ainda.
                </div>
              )}
              {filtered.map((c) => (
                <ConversationItem
                  key={c.id}
                  conv={c}
                  active={c.id === selectedId}
                  onClick={() => navigate({ search: { c: c.id } })}
                />
              ))}
            </div>
          </ScrollArea>
        </motion.div>

        {/* CENTER: Chat */}
        <motion.div layout className="bento-card flex min-h-0 flex-col">
          {selected ? (
            <ChatThread conv={selected} />
          ) : (
            <EmptyState />
          )}
        </motion.div>

        {/* RIGHT: Context panel */}
        <motion.div layout className="hidden min-h-0 md:flex">
          <ContextPanel conv={selected} />
        </motion.div>
      </div>
    </div>
  );
}

function ConversationItem({ conv, active, onClick }: { conv: Conversation; active: boolean; onClick: () => void }) {
  const name = conv.contacts?.name || conv.contacts?.phone;
  const initials = (name ?? "?").slice(0, 2).toUpperCase();
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all",
        active ? "bg-accent" : "hover:bg-muted",
      )}
    >
      <Avatar className="h-10 w-10 shrink-0">
        <AvatarFallback className="bg-brand text-brand-foreground text-xs font-semibold">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="shrink-0 text-[10px] text-muted-foreground">
            {conv.last_message_at ? new Date(conv.last_message_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}
          </div>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <div className="truncate text-xs text-muted-foreground">{conv.last_message_preview ?? "Sem mensagens"}</div>
          {conv.ai_enabled && <Sparkles className="h-3 w-3 shrink-0 text-brand" />}
        </div>
      </div>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-3xl bg-brand-soft text-brand">
        <MessageSquare className="h-7 w-7" />
      </div>
      <h3 className="text-lg font-semibold" style={{ fontFamily: "Instrument Serif, serif", fontSize: 26 }}>
        Selecione uma conversa
      </h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        Escolha um contato ao lado ou inicie uma nova conversa. A IA sugere respostas em tempo real.
      </p>
    </div>
  );
}

function ChatThread({ conv }: { conv: Conversation }) {
  const qc = useQueryClient();
  const sendFn = useServerFn(sendMessage);
  const uploadFn = useServerFn(uploadMedia);
  const suggestFn = useServerFn(suggestReply);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", conv.id],
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from("messages").select("*").eq("conversation_id", conv.id).order("created_at").limit(500);
      if (error) throw error;
      return (data ?? []) as any;
    },
  });

  const [text, setText] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, conv.id]);

  const sendMut = useMutation({
    mutationFn: async (payload: { text?: string; mediaUrl?: string; mediaType?: any; fileName?: string }) => {
      return sendFn({ data: { conversationId: conv.id, ...payload } });
    },
    onSuccess: (res) => {
      if (!res.sent) toast.error("Falha ao enviar: " + (res.errorMessage ?? "erro"));
      qc.invalidateQueries({ queryKey: ["messages", conv.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  async function handleSend() {
    const t = text.trim();
    if (!t) return;
    setText("");
    sendMut.mutate({ text: t });
  }

  async function handleSuggest() {
    setSuggesting(true);
    try {
      const r = await suggestFn({ data: { conversationId: conv.id } });
      setText(r.text);
    } catch (e: any) {
      toast.error("IA: " + e.message);
    } finally {
      setSuggesting(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      try {
        const up = await uploadFn({ data: { filename: file.name, contentType: file.type, dataUrl } });
        const mediaType = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "document";
        sendMut.mutate({ mediaUrl: up.url, mediaType: mediaType as any, fileName: file.name });
      } catch (err: any) {
        toast.error("Upload: " + err.message);
      }
    };
    reader.readAsDataURL(file);
  }

  const contactName = conv.contacts?.name || conv.contacts?.phone;
  const initials = (contactName ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Avatar className="h-10 w-10">
          <AvatarFallback className="bg-brand text-brand-foreground text-xs font-semibold">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <div className="text-sm font-semibold">{contactName}</div>
          <div className="text-[11px] text-muted-foreground">{conv.contacts?.phone}</div>
        </div>
        <Badge variant={conv.ai_enabled ? "default" : "outline"} className="rounded-full">
          {conv.ai_enabled ? <><Sparkles className="mr-1 h-3 w-3" /> IA ativa</> : "Manual"}
        </Badge>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-gradient-to-b from-transparent to-muted/30 px-4 py-4">
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <MessageBubble key={m.id} m={m} />
          ))}
        </AnimatePresence>
      </div>

      {/* composer */}
      <div className="border-t p-3">
        <div className="flex items-end gap-2">
          <label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-xl text-muted-foreground hover:bg-muted">
            <Paperclip className="h-4 w-4" />
            <input type="file" className="hidden" onChange={handleFile} />
          </label>
          <AudioRecorder onRecorded={(dataUrl, mime) => {
            uploadFn({ data: { filename: `audio-${Date.now()}.webm`, contentType: mime, dataUrl } })
              .then((up) => sendMut.mutate({ mediaUrl: up.url, mediaType: "audio" }))
              .catch((e) => toast.error("Áudio: " + e.message));
          }} />
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Digite uma mensagem..."
            className="min-h-[40px] flex-1 resize-none"
            rows={1}
          />
          <Button variant="outline" size="icon" onClick={handleSuggest} disabled={suggesting} title="Sugestão da IA">
            {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          </Button>
          <Button onClick={handleSend} disabled={sendMut.isPending || !text.trim()} size="icon">
            {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: Message }) {
  const out = m.direction === "out";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn("flex", out ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
          out ? "rounded-br-md bg-brand text-brand-foreground" : "rounded-bl-md bg-surface",
          m.sent_by === "ai" && "ring-1 ring-brand/40",
        )}
      >
        {m.sent_by === "ai" && (
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider opacity-70">
            <Sparkles className="h-3 w-3" /> IA
          </div>
        )}
        {m.type === "image" && m.media_url && (
          <img src={m.media_url} alt="" className="mb-1 max-h-64 rounded-lg" />
        )}
        {m.type === "audio" && m.media_url && (
          <audio src={m.media_url} controls className="mb-1 max-w-full" />
        )}
        {m.type === "video" && m.media_url && (
          <video src={m.media_url} controls className="mb-1 max-h-64 rounded-lg" />
        )}
        {m.type === "document" && m.media_url && (
          <a href={m.media_url} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-lg bg-black/10 p-2 text-xs">
            <FileText className="h-4 w-4" /> Documento
          </a>
        )}
        {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
        <div className={cn("mt-1 text-[10px] opacity-60", out ? "text-right" : "")}>
          {new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          {out && m.status && ` · ${m.status === "sent" ? "✓" : m.status === "failed" ? "!" : "…"}`}
        </div>
      </div>
    </motion.div>
  );
}

function AudioRecorder({ onRecorded }: { onRecorded: (dataUrl: string, mime: string) => void }) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const mr = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      mr.ondataavailable = (e) => chunks.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunks.current, { type: mime });
        stream.getTracks().forEach((t) => t.stop());
        const reader = new FileReader();
        reader.onload = () => onRecorded(reader.result as string, mime);
        reader.readAsDataURL(blob);
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
    } catch (e: any) {
      toast.error("Microfone: " + e.message);
    }
  }
  function stop() {
    recRef.current?.stop();
    setRecording(false);
  }

  return (
    <Button
      type="button"
      variant={recording ? "destructive" : "outline"}
      size="icon"
      onClick={recording ? stop : start}
      title={recording ? "Parar gravação" : "Gravar áudio"}
    >
      {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
    </Button>
  );
}

function ContextPanel({ conv }: { conv: Conversation | null }) {
  const qc = useQueryClient();
  const summarizeFn = useServerFn(summarizeConversation);
  const [summarizing, setSummarizing] = useState(false);

  const { data: quickReplies = [] } = useQuery({
    queryKey: ["quick_replies"],
    queryFn: async () => {
      const { data } = await supabase.from("quick_replies").select("*").order("shortcut");
      return data ?? [];
    },
  });

  async function toggleAI() {
    if (!conv) return;
    await supabase.from("conversations").update({ ai_enabled: !conv.ai_enabled }).eq("id", conv.id);
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }
  async function summarize() {
    if (!conv) return;
    setSummarizing(true);
    try {
      await summarizeFn({ data: { conversationId: conv.id } });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      toast.success("Resumo gerado");
    } catch (e: any) { toast.error(e.message); } finally { setSummarizing(false); }
  }

  return (
    <div className="grid h-full min-h-0 w-full grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
      {/* Contact card */}
      <div className="bento-card p-4">
        {conv ? (
          <div>
            <div className="flex items-center gap-3">
              <Avatar className="h-11 w-11">
                <AvatarFallback className="bg-brand text-brand-foreground font-semibold">
                  {(conv.contacts?.name ?? conv.contacts?.phone).slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{conv.contacts?.name ?? "Sem nome"}</div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <PhoneCall className="h-3 w-3" /> {conv.contacts?.phone}
                </div>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={toggleAI}>
                <Sparkles className="mr-1 h-3.5 w-3.5" />
                {conv.ai_enabled ? "Desativar IA" : "Ativar IA"}
              </Button>
              <Button variant="outline" size="sm" className="flex-1" onClick={summarize} disabled={summarizing}>
                {summarizing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <UserIcon className="mr-1 h-3.5 w-3.5" />}
                Resumir
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Selecione uma conversa</div>
        )}
      </div>

      {/* Summary */}
      <div className="bento-card p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resumo IA</h3>
        <p className="text-sm leading-relaxed text-foreground/80">
          {conv?.ai_summary ?? <span className="italic text-muted-foreground">Nenhum resumo ainda. Clique em "Resumir".</span>}
        </p>
      </div>

      {/* Quick replies */}
      <div className="bento-card flex min-h-0 flex-col p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Respostas Rápidas</h3>
          <Link to="/settings" className="text-xs text-brand hover:underline">Gerenciar</Link>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1.5">
            {quickReplies.length === 0 && (
              <p className="text-xs italic text-muted-foreground">Crie atalhos em Configurações.</p>
            )}
            {quickReplies.map((q) => (
              <div key={q.id} className="group rounded-lg border p-2 text-xs hover:bg-muted">
                <div className="flex items-center gap-1">
                  <Zap className="h-3 w-3 text-brand" />
                  <span className="font-mono font-semibold">/{q.shortcut}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-muted-foreground">{q.body}</div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function NewConversationDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const startFn = useServerFn(startConversation);
  const sendFn = useServerFn(sendMessage);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await startFn({ data: { phone, name: name || undefined, firstMessage: message || undefined } });
      if (message.trim()) {
        await sendFn({ data: { conversationId: r.conversationId, text: message } });
      }
      onCreated(r.conversationId);
      setOpen(false);
      setPhone(""); setName(""); setMessage("");
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="outline" className="h-8 w-8"><Plus className="h-4 w-4" /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Nova conversa</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Telefone (com DDI, ex: 5511999998888)</label>
            <Input required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="5511999998888" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Nome (opcional)</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Primeira mensagem (opcional)</label>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Iniciar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
