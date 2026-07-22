
# CRM WhatsApp — Fase 1

Foco: base sólida com **inbox multi-atendente + construtor de fluxo + IA de atendimento**, integrada via conector WhatsApp Business (Sinch). Envio/recebimento de áudio, iniciar conversas e "extras" ficam para a fase 2, mas a arquitetura já será preparada.

## O que você terá no final da fase 1

- **Login e equipe**: cadastro/login por email+senha e Google. Papéis: `admin` (gerencia equipe, fluxos, integração) e `agent` (atende conversas). Admin convida atendentes por email.
- **Inbox estilo WhatsApp Web (bento grid)**:
  - Painel esquerdo: filas de conversas (Aguardando, Minhas, Todas, Resolvidas), busca e filtros por tag.
  - Painel central: thread da conversa, envio de texto, emojis, anexos de imagem/documento e **gravação/envio de áudio** (via microfone do navegador → upload → envio pela API do WhatsApp).
  - Painel direito (bento): dados do contato, resumo da IA, tags, atendente atribuído, histórico.
  - Barra de respostas rápidas com atalho `/` (snippets salvos por atendente e por equipe).
- **Iniciar conversas** (dentro das regras do WhatsApp Business): enviar mensagem ativa usando templates aprovados, ou continuar dentro da janela de 24h.
- **IA de atendimento** (Lovable AI Gateway, sem chave externa):
  - **Sugerir resposta**: botão "Sugerir" na thread; atendente edita/envia.
  - **Auto-atender no início**: quando uma nova conversa entra e nenhum atendente está atribuído, a IA responde as primeiras N mensagens seguindo um prompt-base + fluxo ativo, até o cliente pedir humano, a IA detectar handoff, ou o admin desativar.
  - **Resumir + extrair dados**: nome, email, telefone secundário, intenção e tags automáticas — salvos no card do contato e recalculados quando a conversa avança.
- **Construtor de fluxo visual**:
  - Canvas com nós (React Flow): `Gatilho` (nova conversa / palavra-chave), `Mensagem`, `Pergunta` (aguarda resposta do cliente), `Condição` (regra sobre a resposta), `Ação` (atribuir a atendente, aplicar tag, encerrar, chamar IA).
  - Ligações do tipo "resposta X → próximo nó Y".
  - Publicar/despublicar fluxo; um fluxo ativo por vez na fase 1.
  - Simulador embutido para testar o fluxo antes de publicar.
- **Visual bento grid, responsivo, animado**: layout em blocos com cantos generosos, camadas de sombra/gradiente sutis, transições suaves com Motion (aparição de mensagens, contadores, painéis deslizantes, hover nos cards do bento). Design definido a partir de opções visuais (ver Aprovação do design abaixo).

## Como as peças se conectam

```text
Cliente WhatsApp ──▶ Sinch (WhatsApp Business API)
                        │
                        ▼
        Webhook público /api/public/whatsapp/webhook
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   Salva msg      Roda fluxo ativo   Dispara IA
   (Lovable Cloud) (se aplicável)   (sugerir/auto)
        │
        ▼
   Realtime → UI do atendente (inbox)
        │
        ▼
   Atendente responde ──▶ server fn ──▶ Sinch API ──▶ Cliente
```

## Fluxo de decisões do time

- **Backend**: Lovable Cloud (Postgres + Auth + Storage + Realtime), obrigatório para login multi-usuário, histórico, áudios e webhook.
- **WhatsApp**: conector **WhatsApp Business via Sinch** (linkado ao projeto). Webhook público em `/api/public/whatsapp/webhook` com verificação de assinatura.
- **IA**: Lovable AI Gateway com `google/gemini-3-flash-preview` (padrão) para sugerir respostas, atender e resumir. Sem chave adicional do usuário.
- **Áudio**: gravação no navegador (MediaRecorder) → upload para Storage privado → URL assinada → envio como mensagem de mídia via Sinch. Áudios recebidos são armazenados igualmente e reproduzidos na thread. (Transcrição automática de áudio recebido não foi marcada — fica desligada nesta fase, mas o botão "Transcrever" fica disponível sob demanda.)

## Modelo de dados (Lovable Cloud)

- `profiles` (id = auth.users.id, nome, avatar, papel padrão).
- `user_roles` (user_id, role: `admin`|`agent`) — separado do profile por segurança; policies via `has_role()`.
- `contacts` (telefone E.164, nome, dados extraídos pela IA, tags[]).
- `conversations` (contact_id, status: `waiting`|`open`|`resolved`, assigned_agent_id, last_message_at, ai_summary).
- `messages` (conversation_id, direção `in`/`out`, tipo `text`/`image`/`document`/`audio`, corpo, media_path, sinch_id, sent_by: `customer`|`agent`|`ai`|`flow`, created_at).
- `quick_replies` (owner scope: user ou team, shortcut, body).
- `templates` (nome, idioma, corpo, status de aprovação Sinch/Meta).
- `flows` (nome, ativo, versão) + `flow_nodes` + `flow_edges` (grafo do builder).
- `flow_runs` (conversation_id, flow_id, current_node_id, contexto de variáveis) — estado por conversa.
- `tags` (nome, cor).

Todas as tabelas com RLS: cada atendente vê contatos/conversas atribuídas a ele ou não atribuídas; admin vê tudo. Grants `authenticated` + `service_role`. Webhook usa service role só após verificar assinatura.

## Rotas do app

- `/auth` — login/cadastro (email+senha, Google via broker gerenciado).
- `/` — redireciona logado para `/inbox`; deslogado para `/auth`.
- `/inbox` — inbox principal (bento grid com 3 painéis).
- `/inbox/$conversationId` — conversa focada.
- `/contacts` — lista de contatos + iniciar nova conversa (por template).
- `/flows` — lista de fluxos.
- `/flows/$flowId` — editor visual (React Flow) + simulador.
- `/quick-replies` — gerenciar respostas rápidas (pessoal + equipe).
- `/settings/team` — admin: convidar/remover atendentes, atribuir papéis.
- `/settings/integrations` — status da conexão Sinch, número do WhatsApp, templates.
- `/settings/ai` — prompt base da IA, comportamento (sugerir vs. auto-atender), palavras de handoff.
- `/api/public/whatsapp/webhook` — receber eventos Sinch (verificação de assinatura).

## Aprovação do design (antes de codar a UI)

Depois deste plano ser aprovado, vou:
1. Gerar 2–3 direções visuais bento grid animado (paleta, densidade, sensação — algo tipo "cockpit calmo") e você escolhe uma.
2. Só então construir a UI conforme a escolhida.

## Fora do escopo desta fase (fica para depois)

- Transferência entre setores/times.
- Múltiplos fluxos ativos simultâneos + versionamento avançado.
- Relatórios/BI, SLA, horários de atendimento.
- Transcrição automática de todos os áudios recebidos (fica manual sob demanda).
- Chatbot com botões nativos do WhatsApp e listas — entra na fase 2.
- Aprovação de templates dentro do app (por enquanto, apontamos os já aprovados no Sinch).

## Detalhes técnicos (para referência)

- Stack: TanStack Start (SSR), Lovable Cloud (Supabase gerenciado), Tailwind v4, Motion para animações, React Flow para o builder, shadcn/ui como base, AI Elements onde couber para a UI do painel de IA.
- Segurança: RLS em todas as tabelas; roles em `user_roles` + `has_role()` security definer; webhook verifica HMAC do Sinch antes de gravar; áudios em bucket privado com URLs assinadas.
- IA: chamadas server-side via `createServerFn`; sem exposição de chave no browser. Streaming de sugestão via `useChat`/`streamText` no painel direito.
- Envio ao WhatsApp: `createServerFn` protegido → gateway `standard_connectors` do Sinch → API oficial. Erros do provedor (fora da janela de 24h, template não aprovado, número inválido) são exibidos ao atendente com ação sugerida.
- Realtime: `supabase.channel` por conversa e por caixa de entrada, para novas mensagens e mudanças de atribuição.

## Próximos passos após aprovação

1. Habilitar Lovable Cloud e conectar o conector Sinch (vou te guiar pelo popup).
2. Criar schema + RLS + roles.
3. Gerar direções visuais bento grid, você escolhe uma.
4. Construir: auth + inbox + envio/recebimento (texto e áudio) + webhook.
5. Adicionar respostas rápidas + IA (sugerir, auto-atender, resumir).
6. Adicionar o construtor de fluxo + runner.
7. Configurações (equipe, integração, IA) e polir animações do bento.
