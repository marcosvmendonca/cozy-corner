# Deploy no VPS Contabo com EasyPanel

Guia passo-a-passo pra rodar CRM + Supabase self-host + Evolution API na sua VPS.

**Domínios:**
- `login.fotonardo.com.br` — App CRM (TanStack)
- `loginapi.fotonardo.com.br` — Supabase (API Kong + Studio)
- `evolutionapi.fotonardo.com.br` — Evolution API (WhatsApp QR)

**VPS:** Contabo 4 vCPU / 8GB RAM / 100GB SSD → folgado pra os 3 stacks.

---

## 1. Preparar DNS (antes de tudo)

No painel do registrador do `fotonardo.com.br`, crie 3 registros **A** apontando pro IP público da sua VPS:

| Tipo | Nome | Valor |
|---|---|---|
| A | `login` | `IP_DA_VPS` |
| A | `loginapi` | `IP_DA_VPS` |
| A | `evolutionapi` | `IP_DA_VPS` |

Espere 5–15min pra propagar. Confirme com: `dig +short login.fotonardo.com.br`

---

## 2. Instalar o EasyPanel

Se ainda não tem, na VPS (Ubuntu 22.04+):

```bash
curl -sSL https://get.easypanel.io | sh
```

Acesse `http://IP_DA_VPS:3000`, crie a conta admin.

---

## 3. Criar o Project no EasyPanel

Dentro do EasyPanel, crie um **Project** chamado `fotonardo`. Todos os serviços abaixo vão dentro dele.

---

## 4. Stack: Supabase self-host

Esta é a peça mais complexa — recomendo usar o template do próprio Supabase.

### 4.1. Criar a app no EasyPanel

- No project `fotonardo`, clique **+ Service → App**
- Nome: `supabase`
- **Source:** Git repository
  - URL: `https://github.com/supabase/supabase`
  - Branch: `master`
  - Build Path: `/docker`
- **Build:** Docker Compose
  - Compose file: `docker-compose.yml`

Alternativa mais simples: em vez de EasyPanel App, use `docker-compose` direto por SSH (mais estável pro Supabase). Vou dar as duas opções abaixo.

### 4.2. Via docker-compose (recomendado)

SSH na VPS:

```bash
mkdir -p /opt/supabase && cd /opt/supabase
git clone --depth 1 https://github.com/supabase/supabase.git
cp -R supabase/docker/* .
cp supabase/docker/.env.example .env
rm -rf supabase
```

Edite `.env`:

```env
############
# Secrets — TROQUE TODOS
############
POSTGRES_PASSWORD=<gere-uma-senha-forte-32-chars>
JWT_SECRET=<gere-um-jwt-secret-40-chars>
ANON_KEY=<vai-gerar-no-passo-4.3>
SERVICE_ROLE_KEY=<vai-gerar-no-passo-4.3>
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<senha-do-studio>
SECRET_KEY_BASE=<gere-64-chars>
VAULT_ENC_KEY=<gere-32-chars>

############
# API — URL pública
############
API_EXTERNAL_URL=https://loginapi.fotonardo.com.br
SUPABASE_PUBLIC_URL=https://loginapi.fotonardo.com.br
SITE_URL=https://login.fotonardo.com.br
ADDITIONAL_REDIRECT_URLS=https://login.fotonardo.com.br

############
# SMTP (opcional, pra emails de confirmação — pode deixar pra depois)
############
SMTP_ADMIN_EMAIL=admin@fotonardo.com.br
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_SENDER_NAME=Fotonardo

############
# Studio
############
STUDIO_DEFAULT_ORGANIZATION=Fotonardo
STUDIO_DEFAULT_PROJECT=CRM
```

Gerar segredos:
```bash
openssl rand -hex 32   # POSTGRES_PASSWORD, VAULT_ENC_KEY
openssl rand -hex 40   # JWT_SECRET
openssl rand -hex 64   # SECRET_KEY_BASE
```

### 4.3. Gerar ANON_KEY e SERVICE_ROLE_KEY

Use https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys — cole seu `JWT_SECRET` na página e ela gera as 2 chaves. Cole no `.env`.

### 4.4. Subir Supabase

```bash
cd /opt/supabase
docker compose up -d
```

Confirme: `docker compose ps` — todos devem estar `healthy` em ~2min.

### 4.5. Expor via EasyPanel (proxy + SSL)

No EasyPanel:
- **+ Service → App** → Nome: `supabase-proxy`
- **Source: Docker Image** → `nginx:alpine` (só placeholder, não vamos usar)
- Na verdade, mais simples: use **Traefik** que já vem no EasyPanel.

Melhor caminho: crie um serviço vazio no EasyPanel e configure só o **Domain**:
- Domain: `loginapi.fotonardo.com.br`
- Porta interna: `8000` (porta do Kong do Supabase)
- Marque **HTTPS** + **Let's Encrypt**

OU edite `/opt/supabase/docker-compose.yml` e adicione labels do Traefik no serviço `kong`:
```yaml
  kong:
    # ... resto igual
    labels:
      - traefik.enable=true
      - traefik.http.routers.supabase.rule=Host(`loginapi.fotonardo.com.br`)
      - traefik.http.routers.supabase.tls=true
      - traefik.http.routers.supabase.tls.certresolver=letsencrypt
      - traefik.http.services.supabase.loadbalancer.server.port=8000
    networks:
      - default
      - easypanel  # rede do EasyPanel/Traefik
```

Teste: `curl https://loginapi.fotonardo.com.br/rest/v1/` → deve retornar 401 (esperado).

Studio: `https://loginapi.fotonardo.com.br` → login com `DASHBOARD_USERNAME/PASSWORD`.

### 4.6. Rodar as migrations do CRM

Dentro do Studio (`https://loginapi.fotonardo.com.br`) → SQL Editor → cole o conteúdo de cada arquivo em `supabase/migrations/` do repositório do app, em ordem cronológica, e rode.

Alternativa via CLI (mais rápido):
```bash
# na VPS
docker exec -i supabase-db psql -U postgres -d postgres < migration.sql
```

### 4.7. Configurar Auth

No Studio → Authentication → URL Configuration:
- Site URL: `https://login.fotonardo.com.br`
- Redirect URLs: `https://login.fotonardo.com.br/**`

Se for usar Google OAuth: Authentication → Providers → Google → cole Client ID + Secret (crie novos no Google Cloud Console apontando o Authorized redirect URI pra `https://loginapi.fotonardo.com.br/auth/v1/callback`).

### 4.8. Criar o Storage bucket

Studio → Storage → New bucket → `whatsapp-media` (private). Depois SQL Editor:
```sql
insert into storage.buckets (id, name, public) values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

create policy "auth read" on storage.objects for select
  to authenticated using (bucket_id = 'whatsapp-media');
create policy "auth write" on storage.objects for insert
  to authenticated with check (bucket_id = 'whatsapp-media');
```

---

## 5. Stack: Evolution API

No EasyPanel → project `fotonardo`:

### 5.1. Redis
- **+ Service → Redis** → Nome: `evolution-redis` → deixe padrão.

### 5.2. Evolution
- **+ Service → App** → Nome: `evolution`
- **Source: Docker Image** → `atendai/evolution-api:latest`
- **Environment:**
  ```env
  SERVER_URL=https://evolutionapi.fotonardo.com.br
  AUTHENTICATION_API_KEY=<gere-uma-chave-forte-openssl-rand-hex-32>
  DATABASE_ENABLED=true
  DATABASE_PROVIDER=postgresql
  DATABASE_CONNECTION_URI=postgresql://postgres:<POSTGRES_PASSWORD>@supabase-db:5432/evolution
  DATABASE_CONNECTION_CLIENT_NAME=evolution
  CACHE_REDIS_ENABLED=true
  CACHE_REDIS_URI=redis://evolution-redis:6379
  CACHE_REDIS_PREFIX_KEY=evolution
  CONFIG_SESSION_PHONE_CLIENT=Fotonardo
  CONFIG_SESSION_PHONE_NAME=Chrome
  QRCODE_LIMIT=30
  ```
- **Domain:** `evolutionapi.fotonardo.com.br` → porta interna `8080` → HTTPS
- **Volume:** monte `/evolution/instances` num volume persistente

Antes de subir, crie o database `evolution` no Postgres do Supabase:
```bash
docker exec -it supabase-db psql -U postgres -c "CREATE DATABASE evolution;"
```

Teste: `curl https://evolutionapi.fotonardo.com.br` → resposta OK.

---

## 6. Stack: App CRM

### 6.1. No EasyPanel

- **+ Service → App** → Nome: `crm`
- **Source: Git repository**
  - URL: seu repo do GitHub
  - Branch: `main`
- **Build: Dockerfile** → `./Dockerfile`
- **Build Args:**
  ```
  VITE_SUPABASE_URL=https://loginapi.fotonardo.com.br
  VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY do passo 4.3>
  VITE_SUPABASE_PROJECT_ID=self-hosted
  ```
- **Environment (runtime):**
  ```
  SUPABASE_URL=https://loginapi.fotonardo.com.br
  SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
  SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
  OPENAI_API_KEY=sk-...
  OPENAI_MODEL=gpt-4o-mini
  NODE_ENV=production
  PORT=3000
  HOST=0.0.0.0
  ```
- **Domain:** `login.fotonardo.com.br` → porta `3000` → HTTPS
- **Deploy**

Build leva ~3–5min. Se falhar por causa do lockfile, rode `bun install` localmente e commite o `bun.lock`.

---

## 7. Configurar o webhook Evolution → CRM

1. Abra `https://login.fotonardo.com.br` → cadastre a conta admin.
2. Configurações → WhatsApp:
   - Base URL: `https://evolutionapi.fotonardo.com.br`
   - API Key: valor de `AUTHENTICATION_API_KEY` do passo 5.2
   - Instance Name: `principal` (ou qualquer nome)
3. Clique **Conectar** → escaneie o QR com o WhatsApp.
4. O webhook é registrado automaticamente pelo app apontando pra `https://login.fotonardo.com.br/api/public/whatsapp/webhook`.

---

## 8. Checklist final

- [ ] `dig login.fotonardo.com.br` retorna IP da VPS
- [ ] `dig loginapi.fotonardo.com.br` retorna IP da VPS
- [ ] `dig evolutionapi.fotonardo.com.br` retorna IP da VPS
- [ ] `https://loginapi.fotonardo.com.br/rest/v1/` retorna 401 (não conexão recusada)
- [ ] Studio abre em `https://loginapi.fotonardo.com.br`
- [ ] Migrations rodadas com sucesso
- [ ] `https://evolutionapi.fotonardo.com.br` responde
- [ ] `https://login.fotonardo.com.br` abre a tela de login
- [ ] Cadastro + login funcionam
- [ ] QR code aparece em Configurações → WhatsApp
- [ ] Mensagens de teste chegam no Inbox

---

## Backup diário (importante!)

Cron na VPS pra dump do Postgres:
```bash
# /etc/cron.daily/supabase-backup
docker exec supabase-db pg_dumpall -U postgres | gzip > /opt/backups/supabase-$(date +\%F).sql.gz
find /opt/backups -mtime +14 -delete
```

---

## Troubleshooting

**Build do app falha com "vite: not found":** rode `bun install` local, commite `bun.lock`.

**Login não funciona / CORS error:** confira `SITE_URL` e `ADDITIONAL_REDIRECT_URLS` no `.env` do Supabase.

**Evolution não recebe QR:** cheque logs `docker logs evolution` — geralmente é `DATABASE_CONNECTION_URI` errado.

**Studio não abre:** o Traefik do EasyPanel talvez esteja em rede separada — adicione o container `kong` à rede do EasyPanel (`docker network connect easypanel_default supabase-kong`).

**IA não funciona:** cheque `OPENAI_API_KEY` no runtime env do app; olhe logs `docker logs crm`.
