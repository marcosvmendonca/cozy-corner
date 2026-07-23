import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { z } from "zod";
import EmojiPicker, { EmojiStyle, Theme as EmojiTheme } from "emoji-picker-react";
import { supabase } from "@/integrations/supabase/client";
import { sendMessage, uploadMedia, deleteMessage, editMessage, forwardMessage } from "@/lib/whatsapp.functions";
import { suggestReply, summarizeConversation } from "@/lib/ai.functions";
import { startConversation } from "@/lib/contacts.functions";
import { acceptTicket, transferTicket, setTicketStatus, suggestQueueForTicket } from "@/lib/tickets.functions";
import { listQueues } from "@/lib/queues.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import {
  Search, Send, Sparkles, Plus, Mic, Square, Paperclip, Zap, Smile,
  MessageSquare, Loader2, User as UserIcon, PhoneCall, FileText,
  Inbox as InboxIcon, Users as UsersIcon, CheckCheck, ArrowRightLeft, HandshakeIcon, PanelRightClose, PanelRightOpen,
  MoreVertical, Trash2, Pencil, Forward, Check, X, Clock, AlertCircle,
  Image as ImageIcon, Film, FileIcon, Contact as ContactIcon,
} from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
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

type Tab = "waiting" | "mine" | "all";

function InboxPage() {
  const { c: selectedId } = Route.useSearch();
  const navigate = useNavigate({ from: "/inbox" });
  const qc = useQueryClient();

  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<Tab>("waiting");
  const [queueFilter, setQueueFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [contextOpen, setContextOpen] = useState(false);

  // Current user + admin
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const { data: role } = await supabase.from("user_roles").select("role").eq("user_id", u.user.id).maybeSingle();
      return { id: u.user.id, email: u.user.email, isAdmin: role?.role === "admin" };
    },
  });

  // Queues (visible to user)
  const listQueuesFn = useServerFn(listQueues);
  const { data: queues = [] } = useQuery({ queryKey: ["queues"], queryFn: () => listQueuesFn() });

  // Agents (for admin filter)
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    enabled: !!me?.isAdmin,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id, full_name, email");
      return data ?? [];
    },
  });

  const { data: conversations = [] } = useQuery({
    queryKey: ["conversations"],
    queryFn: async (): Promise<Conversation[]> => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contacts(*)")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as any;
    },
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  function prefetchMessages(convId: string) {
    qc.prefetchQuery({
      queryKey: ["messages", convId],
      queryFn: async () => {
        const { data } = await supabase
          .from("messages").select("*").eq("conversation_id", convId).is("deleted_at", null).order("created_at").limit(500);
        return (data ?? []) as Message[];
      },
      staleTime: 3000,
    });
  }

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
    return conversations.filter((c) => {
      // tab
      if (tab === "waiting" && c.status !== "waiting") return false;
      if (tab === "mine" && c.assigned_agent_id !== me?.id) return false;
      // "all" needs no status filter

      // queue
      if (queueFilter !== "all") {
        if (queueFilter === "none" && c.queue_id) return false;
        if (queueFilter !== "none" && c.queue_id !== queueFilter) return false;
      }
      // agent (admin)
      if (me?.isAdmin && agentFilter !== "all") {
        if (agentFilter === "none" && c.assigned_agent_id) return false;
        if (agentFilter !== "none" && c.assigned_agent_id !== agentFilter) return false;
      }
      // search
      if (f) {
        const hay = `${c.contacts?.name ?? ""} ${c.contacts?.phone ?? ""} ${c.last_message_preview ?? ""}`.toLowerCase();
        if (!hay.includes(f)) return false;
      }
      return true;
    });
  }, [conversations, filter, tab, queueFilter, agentFilter, me]);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  const waitingCount = conversations.filter((c) => c.status === "waiting").length;
  const mineCount = conversations.filter((c) => c.assigned_agent_id === me?.id && c.status !== "resolved").length;

  const queueMap = useMemo(() => new Map(queues.map((q) => [q.id, q])), [queues]);
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  return (
    <div className="h-full w-full overflow-hidden bg-background p-3 md:p-4">
      <div className={cn(
        "grid h-full grid-cols-1 gap-3 md:gap-4",
        contextOpen && selected ? "md:grid-cols-[360px_minmax(0,1fr)_320px]" : "md:grid-cols-[360px_minmax(0,1fr)]",
      )}>
        {/* LEFT */}
        <motion.div layout className="bento-card flex min-h-0 flex-col">
          <div className="flex items-center justify-between p-4 pb-3">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Conversas</h2>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {waitingCount} aguardando · {mineCount} minhas
              </div>
            </div>
            <NewConversationDialog onCreated={(id) => navigate({ search: { c: id } })} />
          </div>

          {/* Tabs */}
          <div className="mx-3 mb-2 flex gap-1 rounded-xl border bg-surface p-1 text-xs">
            {([
              { k: "waiting", l: "Aguardando", i: HandshakeIcon },
              { k: "mine", l: "Minhas", i: UserIcon },
              { k: "all", l: me?.isAdmin ? "Todas" : "Filas", i: InboxIcon },
            ] as const).map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k)}
                className={cn(
                  "relative flex-1 rounded-lg px-2 py-1.5 font-medium transition",
                  tab === t.k ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab === t.k && <motion.div layoutId="tab-active" className="absolute inset-0 rounded-lg bg-accent" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />}
                <span className="relative flex items-center justify-center gap-1"><t.i className="h-3 w-3" />{t.l}</span>
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="mx-3 mb-2 grid gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Buscar contato..." value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-9 h-9" />
            </div>
            {(queues.length > 0 || me?.isAdmin) && (
              <div className={cn("grid gap-2", me?.isAdmin ? "grid-cols-2" : "grid-cols-1")}>
                {queues.length > 0 && (
                  <Select value={queueFilter} onValueChange={setQueueFilter}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Fila" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas as filas</SelectItem>
                      <SelectItem value="none">Sem fila</SelectItem>
                      {queues.map((q) => <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {me?.isAdmin && (
                  <Select value={agentFilter} onValueChange={setAgentFilter}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Atendente" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos atendentes</SelectItem>
                      <SelectItem value="none">Sem atendente</SelectItem>
                      {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.full_name ?? a.email}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>

          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-1 px-2 pb-2">
              {filtered.length === 0 && (
                <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                  <MessageSquare className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  Nenhuma conversa neste filtro.
                </div>
              )}
              {filtered.map((c) => (
                <ConversationItem
                  key={c.id}
                  conv={c}
                  queue={c.queue_id ? queueMap.get(c.queue_id) : undefined}
                  agent={c.assigned_agent_id ? agentMap.get(c.assigned_agent_id) : undefined}
                  isMine={c.assigned_agent_id === me?.id}
                  active={c.id === selectedId}
                  onClick={() => navigate({ search: { c: c.id } })}
                  onHover={() => prefetchMessages(c.id)}
                />
              ))}
            </div>
          </ScrollArea>
        </motion.div>

        {/* CENTER */}
        <motion.div layout className="bento-card flex min-h-0 flex-col">
          {selected ? (
            <ChatThread
              conv={selected}
              me={me}
              queues={queues}
              contextOpen={contextOpen}
              onToggleContext={() => setContextOpen((v) => !v)}
            />
          ) : (
            <EmptyState />
          )}
        </motion.div>

        {/* RIGHT */}
        {contextOpen && selected && (
          <motion.div
            layout
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="hidden min-h-0 md:flex"
          >
            <ContextPanel conv={selected} queues={queues} agents={agents} isAdmin={!!me?.isAdmin} onClose={() => setContextOpen(false)} />
          </motion.div>
        )}
      </div>
    </div>
  );
}

function ConversationItem({ conv, queue, agent, isMine, active, onClick }: {
  conv: Conversation;
  queue?: { name: string; color: string };
  agent?: { full_name: string | null; email: string | null };
  isMine: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const name = conv.contacts?.name || conv.contacts?.phone;
  const initials = (name ?? "?").slice(0, 2).toUpperCase();
  const waiting = conv.status === "waiting";
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-all",
        active ? "bg-accent" : "hover:bg-muted",
      )}
    >
      <Avatar className="h-10 w-10 shrink-0">
        <AvatarFallback className={cn("text-xs font-semibold", waiting ? "bg-amber-500/20 text-amber-700" : "bg-brand text-brand-foreground")}>
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
        <div className="mt-0.5 flex items-center gap-1.5">
          <div className="truncate text-xs text-muted-foreground">{conv.last_message_preview ?? "Sem mensagens"}</div>
          {conv.ai_enabled && <Sparkles className="h-3 w-3 shrink-0 text-brand" />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {waiting && <Badge variant="outline" className="h-4 rounded-full border-amber-400 px-1.5 text-[9px] text-amber-700">Aguardando</Badge>}
          {queue && (
            <Badge variant="outline" className="h-4 rounded-full px-1.5 text-[9px]" style={{ borderColor: queue.color, color: queue.color }}>
              {queue.name}
            </Badge>
          )}
          {isMine && <Badge className="h-4 rounded-full bg-brand/15 px-1.5 text-[9px] text-brand hover:bg-brand/20">Você</Badge>}
          {agent && !isMine && <Badge variant="secondary" className="h-4 rounded-full px-1.5 text-[9px]">{(agent.full_name ?? agent.email ?? "").split(" ")[0]}</Badge>}
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
        Aceite um ticket em Aguardando para começar. A IA pode sugerir a fila.
      </p>
    </div>
  );
}

function ChatThread({ conv, me, queues, contextOpen, onToggleContext }: {
  conv: Conversation;
  me: { id: string; isAdmin: boolean } | null | undefined;
  queues: Array<{ id: string; name: string; color: string }>;
  contextOpen: boolean;
  onToggleContext: () => void;
}) {
  const qc = useQueryClient();
  const sendFn = useServerFn(sendMessage);
  const uploadFn = useServerFn(uploadMedia);
  const suggestFn = useServerFn(suggestReply);
  const summarizeFn = useServerFn(summarizeConversation);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", conv.id],
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from("messages").select("*").eq("conversation_id", conv.id).is("deleted_at", null).order("created_at").limit(500);
      if (error) throw error;
      return (data ?? []) as any;
    },
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  const [text, setText] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Slash quick replies
  const { data: quickReplies = [] } = useQuery({
    queryKey: ["quick_replies"],
    queryFn: async () => (await supabase.from("quick_replies").select("*").order("shortcut")).data ?? [],
  });
  const slashMatch = text.match(/(?:^|\s)\/(\S*)$/);
  const slashQuery = slashMatch?.[1] ?? null;
  const slashOpen = slashQuery !== null;
  const slashResults = slashOpen
    ? quickReplies.filter((q: any) => q.shortcut.toLowerCase().startsWith((slashQuery ?? "").toLowerCase())).slice(0, 8)
    : [];
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  function applyQuickReply(body: string) {
    // Replace the trailing "/xxx" (with the leading space if present) with body
    const next = text.replace(/(^|\s)\/(\S*)$/, (_m, pre) => `${pre}${body}`);
    setText(next);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

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
    try { const r = await suggestFn({ data: { conversationId: conv.id } }); setText(r.text); }
    catch (e: any) { toast.error("IA: " + e.message); }
    finally { setSuggesting(false); }
  }
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      try {
        const up = await uploadFn({ data: { filename: file.name, contentType: file.type, dataUrl } });
        const mediaType = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "document";
        sendMut.mutate({ mediaUrl: up.url, mediaType: mediaType as any, fileName: file.name });
      } catch (err: any) { toast.error("Upload: " + err.message); }
    };
    reader.readAsDataURL(file);
  }

  async function handleSummarize() {
    setSummarizing(true);
    try { await summarizeFn({ data: { conversationId: conv.id } }); qc.invalidateQueries({ queryKey: ["conversations"] }); toast.success("Resumo gerado"); }
    catch (e: any) { toast.error("IA: " + e.message); }
    finally { setSummarizing(false); }
  }

  const contactName = conv.contacts?.name || conv.contacts?.phone;
  const initials = (contactName ?? "?").slice(0, 2).toUpperCase();

  const isMine = conv.assigned_agent_id === me?.id;
  const canSend = isMine || me?.isAdmin || (conv.queue_id != null); // policy allows; UI just hints
  const waiting = conv.status === "waiting";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <button
          onClick={onToggleContext}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 -m-1 text-left transition hover:bg-muted"
          title="Ver dados do cliente"
        >
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-brand text-brand-foreground text-xs font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{contactName}</div>
            <div className="truncate text-[11px] text-muted-foreground">{conv.contacts?.phone}</div>
          </div>
        </button>
        {conv.status === "resolved" && <Badge variant="secondary" className="rounded-full">Resolvido</Badge>}
        <Badge variant={conv.ai_enabled ? "default" : "outline"} className="rounded-full">
          {conv.ai_enabled ? <><Sparkles className="mr-1 h-3 w-3" /> IA</> : "Manual"}
        </Badge>
        <Button variant="outline" size="sm" onClick={handleSummarize} disabled={summarizing} title="Gerar resumo com IA">
          {summarizing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
          Resumo IA
        </Button>
        <Button variant="ghost" size="icon" onClick={onToggleContext} title={contextOpen ? "Fechar painel" : "Abrir painel do cliente"}>
          {contextOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>

      {/* Accept banner */}
      {waiting && (
        <div className="border-b bg-amber-500/10 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <HandshakeIcon className="h-4 w-4 text-amber-700" />
            <div className="flex-1 text-xs text-amber-900">
              Ticket aguardando atendimento. Aceite para se tornar o responsável e direcionar para uma fila.
            </div>
            <AcceptTicketButton conversationId={conv.id} queues={queues} />
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-gradient-to-b from-transparent to-muted/30 px-4 py-4">
        <AnimatePresence initial={false}>
          {messages.map((m) => (<MessageBubble key={m.id} m={m} currentConversationId={conv.id} />))}
        </AnimatePresence>
      </div>

      <div className="border-t p-3">
        {!canSend && !waiting && (
          <div className="mb-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            Somente o responsável ou membros da fila podem responder.
          </div>
        )}
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
          <div className="relative flex-1">
            {slashOpen && slashResults.length > 0 && (
              <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-60 overflow-auto rounded-xl border bg-popover shadow-lg">
                <div className="border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Respostas rápidas
                </div>
                {slashResults.map((q: any, i: number) => (
                  <button
                    key={q.id}
                    type="button"
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => applyQuickReply(q.body)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition",
                      i === slashIdx ? "bg-accent" : "hover:bg-muted",
                    )}
                  >
                    <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs font-semibold">/{q.shortcut}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{q.body}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {slashOpen && slashResults.length === 0 && (
              <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
                Nenhuma resposta rápida com "/{slashQuery}". <Link to="/settings/quick-replies" className="text-brand hover:underline">Criar</Link>
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (slashOpen && slashResults.length > 0) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashResults.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashResults.length) % slashResults.length); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyQuickReply((slashResults[slashIdx] as any).body); return; }
                  if (e.key === "Escape") { e.preventDefault(); setText(text.replace(/(^|\s)\/(\S*)$/, "$1")); return; }
                }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
              placeholder={waiting ? "Aceite o ticket para responder..." : "Digite uma mensagem... (use / para respostas rápidas)"}
              className="min-h-[40px] w-full resize-none"
              rows={1}
              disabled={waiting}
            />
          </div>
          <Button variant="outline" size="icon" onClick={handleSuggest} disabled={suggesting || waiting} title="Sugestão da IA">
            {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          </Button>
          <Button onClick={handleSend} disabled={sendMut.isPending || !text.trim() || waiting} size="icon">
            {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AcceptTicketButton({ conversationId, queues }: {
  conversationId: string;
  queues: Array<{ id: string; name: string; color: string }>;
}) {
  const qc = useQueryClient();
  const acceptFn = useServerFn(acceptTicket);
  const suggestFn = useServerFn(suggestQueueForTicket);
  const [open, setOpen] = useState(false);
  const [queueId, setQueueId] = useState<string>("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestReason, setSuggestReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function iaSuggest() {
    setSuggesting(true); setSuggestReason(null);
    try {
      const r = await suggestFn({ data: { conversationId } });
      if (r.queueId) { setQueueId(r.queueId); setSuggestReason(r.reason || `Sugerida: ${r.queueName}`); }
      else setSuggestReason(r.reason || "IA não conseguiu escolher");
    } catch (e: any) { toast.error(e.message); }
    finally { setSuggesting(false); }
  }
  async function confirm() {
    if (!queueId) return toast.error("Escolha uma fila");
    setBusy(true);
    try {
      await acceptFn({ data: { conversationId, queueId } });
      toast.success("Ticket aceito");
      qc.invalidateQueries({ queryKey: ["conversations"] });
      setOpen(false);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-7">Aceitar ticket</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aceitar ticket</DialogTitle>
          <DialogDescription>Você vira o responsável e escolhe a fila que o ticket vai seguir.</DialogDescription>
        </DialogHeader>
        {queues.length === 0 ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            Nenhuma fila disponível. Crie uma em <Link to="/settings/queues" className="text-brand underline">Configurações → Filas</Link>.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Fila</label>
              <Select value={queueId} onValueChange={setQueueId}>
                <SelectTrigger><SelectValue placeholder="Escolher fila..." /></SelectTrigger>
                <SelectContent>
                  {queues.map((q) => (
                    <SelectItem key={q.id} value={q.id}>
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: q.color }} /> {q.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={iaSuggest} disabled={suggesting} className="w-full">
              {suggesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Deixar a IA sugerir a fila
            </Button>
            {suggestReason && <div className="rounded-lg border bg-brand-soft/40 px-3 py-2 text-xs">{suggestReason}</div>}
          </div>
        )}
        <DialogFooter>
          <Button onClick={confirm} disabled={busy || !queueId || queues.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Aceitar e assumir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MessageBubble({ m, currentConversationId }: { m: Message; currentConversationId: string }) {
  const out = m.direction === "out";
  const qc = useQueryClient();
  const deleteFn = useServerFn(deleteMessage);
  const editFn = useServerFn(editMessage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body ?? "");
  const [forwardOpen, setForwardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleted = !!(m as any).deleted_at;
  const edited = !!(m as any).edited_at;
  const ageMin = (Date.now() - new Date(m.created_at).getTime()) / 60000;
  const canEdit = out && m.type === "text" && !deleted && ageMin <= 15;
  const canDelete = out && !deleted;

  async function handleDelete() {
    setBusy(true);
    try {
      await deleteFn({ data: { messageId: m.id } });
      qc.invalidateQueries({ queryKey: ["messages", currentConversationId] });
      setConfirmDelete(false);
    }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }
  async function handleEditSave() {
    const t = draft.trim();
    if (!t || t === m.body) { setEditing(false); return; }
    setBusy(true);
    try { await editFn({ data: { messageId: m.id, text: t } }); qc.invalidateQueries({ queryKey: ["messages", currentConversationId] }); setEditing(false); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
      className={cn("group flex items-start gap-1", out ? "justify-end" : "justify-start")}
    >
      {out && !deleted && (
        <MessageActions
          onEdit={canEdit ? () => { setDraft(m.body ?? ""); setEditing(true); } : undefined}
          onDelete={canDelete ? () => setConfirmDelete(true) : undefined}
          onForward={() => setForwardOpen(true)}
          busy={busy}
        />
      )}
      <div className={cn(
        "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm shadow-sm transition-opacity duration-300",
        out ? "rounded-br-md bg-brand text-brand-foreground" : "rounded-bl-md bg-surface",
        m.sent_by === "ai" && "ring-1 ring-brand/40",
        deleted && "italic opacity-40",
        busy && !deleted && "opacity-50",
      )}>
        {m.sent_by === "ai" && !deleted && (
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider opacity-70">
            <Sparkles className="h-3 w-3" /> IA
          </div>
        )}
        {deleted ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 text-xs cursor-help">
                  <Trash2 className="h-3 w-3" /> Mensagem apagada
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">
                Mensagem apagada{(m as any).deleted_at ? ` em ${new Date((m as any).deleted_at).toLocaleString("pt-BR")}` : ""}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : editing ? (
          <div className="flex flex-col gap-1.5">
            <Textarea
              value={draft} onChange={(e) => setDraft(e.target.value)}
              className="min-h-[60px] bg-white/90 text-foreground"
              autoFocus
            />
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}><X className="h-3.5 w-3.5" /></Button>
              <Button size="sm" onClick={handleEditSave} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}</Button>
            </div>
          </div>
        ) : (
          <>
            {m.type === "image" && m.media_url && <img src={m.media_url} alt="" className="mb-1 max-h-64 rounded-lg" />}
            {m.type === "audio" && m.media_url && <audio src={m.media_url} controls className="mb-1 max-w-full" />}
            {m.type === "video" && m.media_url && <video src={m.media_url} controls className="mb-1 max-h-64 rounded-lg" />}
            {m.type === "document" && m.media_url && (
              <a href={m.media_url} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-lg bg-black/10 p-2 text-xs">
                <FileText className="h-4 w-4" /> Documento
              </a>
            )}
            {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
          </>
        )}
        {!deleted && !editing && (
          <div className={cn("mt-1 text-[10px] opacity-60", out ? "text-right" : "")}>
            {new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            {edited && " · editada"}
            {out && m.status && ` · ${m.status === "sent" ? "✓" : m.status === "failed" ? "!" : "…"}`}
          </div>
        )}
      </div>
      {!out && !deleted && (
        <MessageActions onForward={() => setForwardOpen(true)} busy={busy} />
      )}
      {forwardOpen && (
        <ForwardDialog
          messageId={m.id}
          currentConversationId={currentConversationId}
          open={forwardOpen}
          onOpenChange={setForwardOpen}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={(o) => !busy && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar mensagem?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação apaga a mensagem para todos no WhatsApp. Não é possível desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Apagando...</>) : (<><Trash2 className="mr-2 h-4 w-4" /> Apagar</>)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}

function MessageActions({ onEdit, onDelete, onForward, busy }: {
  onEdit?: () => void;
  onDelete?: () => void;
  onForward?: () => void;
  busy?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost" size="icon"
          className="mt-1 h-7 w-7 opacity-0 transition group-hover:opacity-100 data-[state=open]:opacity-100"
          disabled={busy}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {onForward && (
          <DropdownMenuItem onClick={onForward}><Forward className="mr-2 h-4 w-4" /> Encaminhar</DropdownMenuItem>
        )}
        {onEdit && (
          <DropdownMenuItem onClick={onEdit}><Pencil className="mr-2 h-4 w-4" /> Editar</DropdownMenuItem>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" /> Apagar
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ForwardDialog({ messageId, currentConversationId, open, onOpenChange }: {
  messageId: string;
  currentConversationId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const forwardFn = useServerFn(forwardMessage);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data: convs = [] } = useQuery({
    queryKey: ["forward-conversations"],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("conversations")
        .select("id, contacts(name, phone)")
        .neq("id", currentConversationId)
        .order("last_message_at", { ascending: false })
        .limit(100);
      return (data ?? []) as any[];
    },
  });

  const filtered = convs.filter((c: any) => {
    const q = filter.toLowerCase();
    return !q || (c.contacts?.name ?? "").toLowerCase().includes(q) || (c.contacts?.phone ?? "").includes(q);
  });

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  async function confirm() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const r = await forwardFn({ data: { messageId, targetConversationIds: Array.from(selected) } });
      const okCount = r.results.filter((x) => x.ok).length;
      const failCount = r.results.length - okCount;
      if (okCount) toast.success(`Encaminhada para ${okCount} conversa(s)`);
      if (failCount) toast.error(`Falha em ${failCount} conversa(s)`);
      onOpenChange(false);
      setSelected(new Set());
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Encaminhar mensagem</DialogTitle>
          <DialogDescription>Selecione uma ou mais conversas.</DialogDescription>
        </DialogHeader>
        <Input placeholder="Buscar contato…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <ScrollArea className="h-72 rounded-md border">
          <div className="divide-y">
            {filtered.map((c: any) => {
              const name = c.contacts?.name || c.contacts?.phone || "Sem nome";
              const active = selected.has(c.id);
              return (
                <button
                  key={c.id} type="button" onClick={() => toggle(c.id)}
                  className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition", active ? "bg-accent" : "hover:bg-muted")}
                >
                  <Avatar className="h-8 w-8"><AvatarFallback className="text-xs">{name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{c.contacts?.phone}</div>
                  </div>
                  {active && <Check className="h-4 w-4 text-brand" />}
                </button>
              );
            })}
            {filtered.length === 0 && <div className="p-4 text-center text-xs text-muted-foreground">Nenhuma conversa</div>}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancelar</Button>
          <Button onClick={confirm} disabled={busy || selected.size === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : `Encaminhar (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      mr.start(); recRef.current = mr; setRecording(true);
    } catch (e: any) { toast.error("Microfone: " + e.message); }
  }
  function stop() { recRef.current?.stop(); setRecording(false); }
  return (
    <Button type="button" variant={recording ? "destructive" : "outline"} size="icon" onClick={recording ? stop : start} title={recording ? "Parar" : "Gravar"}>
      {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
    </Button>
  );
}

function ContextPanel({ conv, queues, agents, isAdmin, onClose }: {
  conv: Conversation;
  queues: Array<{ id: string; name: string; color: string }>;
  agents: Array<{ id: string; full_name: string | null; email: string | null }>;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const transferFn = useServerFn(transferTicket);
  const statusFn = useServerFn(setTicketStatus);

  async function toggleAI() {
    await supabase.from("conversations").update({ ai_enabled: !conv.ai_enabled }).eq("id", conv.id);
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }
  async function changeQueue(qid: string) {
    await transferFn({ data: { conversationId: conv.id, queueId: qid === "none" ? null : qid } });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }
  async function changeAgent(aid: string) {
    await transferFn({ data: { conversationId: conv.id, agentId: aid === "none" ? null : aid } });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }
  async function resolve() {
    await statusFn({ data: { conversationId: conv.id, status: conv.status === "resolved" ? "open" : "resolved" } });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }

  const extracted = (conv.contacts?.extracted_data ?? null) as Record<string, any> | null;

  return (
    <div className="grid h-full min-h-0 w-full grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-3">
      <div className="bento-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dados do cliente</h3>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} title="Fechar">
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Avatar className="h-11 w-11">
            <AvatarFallback className="bg-brand text-brand-foreground font-semibold">
              {(conv.contacts?.name ?? conv.contacts?.phone ?? "?").slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{conv.contacts?.name ?? "Sem nome"}</div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <PhoneCall className="h-3 w-3" /> {conv.contacts?.phone}
            </div>
            {conv.contacts?.email && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{conv.contacts.email}</div>
            )}
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={toggleAI}>
            <Sparkles className="mr-1 h-3.5 w-3.5" />
            {conv.ai_enabled ? "IA off" : "IA on"}
          </Button>
          <Button variant="outline" size="sm" className="flex-1" onClick={resolve}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" />
            {conv.status === "resolved" ? "Reabrir" : "Resolver"}
          </Button>
        </div>
      </div>

      {/* Assign */}
      {conv.status !== "waiting" && (
        <div className="bento-card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <ArrowRightLeft className="h-3 w-3" /> Encaminhamento
          </div>
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Fila</div>
              <Select value={conv.queue_id ?? "none"} onValueChange={changeQueue}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem fila</SelectItem>
                  {queues.map((q) => <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {isAdmin && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Atendente</div>
                <Select value={conv.assigned_agent_id ?? "none"} onValueChange={changeAgent}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sem atendente</SelectItem>
                    {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.full_name ?? a.email}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bento-card p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resumo IA</h3>
        <p className="text-sm leading-relaxed text-foreground/80">
          {conv.ai_summary ?? <span className="italic text-muted-foreground">Nenhum resumo ainda. Clique em "Resumo IA" acima do chat.</span>}
        </p>
      </div>

      <div className="bento-card flex min-h-0 flex-col p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dados extraídos</h3>
        <ScrollArea className="min-h-0 flex-1">
          {extracted && Object.keys(extracted).length > 0 ? (
            <dl className="space-y-1.5 text-xs">
              {Object.entries(extracted).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-24 shrink-0 font-medium capitalize text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 flex-1 break-words">{Array.isArray(v) ? v.join(", ") : (v == null ? "—" : String(v))}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs italic text-muted-foreground">Nenhum dado extraído ainda. Gere um resumo para extrair.</p>
          )}
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
    e.preventDefault(); setBusy(true);
    try {
      const r = await startFn({ data: { phone, name: name || undefined, firstMessage: message || undefined } });
      if (message.trim()) await sendFn({ data: { conversationId: r.conversationId, text: message } });
      onCreated(r.conversationId); setOpen(false); setPhone(""); setName(""); setMessage("");
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
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Iniciar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
