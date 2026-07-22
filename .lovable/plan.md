
# Deploy passo-a-passo — Fase atual: Supabase self-host

DNS + EasyPanel prontos. Próximo bloco é subir o Supabase na VPS. Vou te guiar em blocos pequenos — você executa, cola o resultado, eu destravo o próximo.

## Bloco 1 (agora) — Subir Supabase via docker-compose

Isso segue a seção **4.2 → 4.4** do `DEPLOY.md`. Prefiro docker-compose direto por SSH em vez de app do EasyPanel — é o método oficial do Supabase e evita dor de cabeça com o Traefik do painel na primeira subida.

### Passos que você executa

1. **SSH na VPS** como root (ou usuário com docker).
2. Clonar e preparar o diretório:
   ```bash
   mkdir -p /opt/supabase && cd /opt/supabase
   git clone --depth 1 https://github.com/supabase/supabase.git
   cp -R supabase/docker/* .
   cp supabase/docker/.env.example .env
   rm -rf supabase
   ```
3. **Gerar segredos** (rode e guarde cada um num bloco de notas):
   ```bash
   openssl rand -hex 32   # POSTGRES_PASSWORD
   openssl rand -hex 32   # VAULT_ENC_KEY
   openssl rand -hex 40   # JWT_SECRET
   openssl rand -hex 64   # SECRET_KEY_BASE
   ```
4. **Gerar ANON_KEY + SERVICE_ROLE_KEY** a partir do `JWT_SECRET`: abra https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys, cole o `JWT_SECRET` e copie as duas chaves geradas.
5. **Editar `/opt/supabase/.env`** preenchendo tudo (uso os teus domínios):
   - `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`
   - `DASHBOARD_USERNAME=admin` + `DASHBOARD_PASSWORD=<escolhe uma senha>`
   - `API_EXTERNAL_URL=https://loginapi.fotonardo.com.br`
   - `SUPABASE_PUBLIC_URL=https://loginapi.fotonardo.com.br`
   - `SITE_URL=https://login.fotonardo.com.br`
   - `ADDITIONAL_REDIRECT_URLS=https://login.fotonardo.com.br/**`
   - SMTP pode deixar em branco por enquanto (email de confirmação vem depois)
6. **Subir**:
   ```bash
   cd /opt/supabase
   docker compose up -d
   docker compose ps
   ```
   Espere ~2 min e confirme que todos os serviços estão `healthy` / `running`.

### O que me manda quando terminar

- Output de `docker compose ps` (só pra confirmar que subiu tudo)
- Confirmação de que anotou as chaves geradas (não me manda elas)
- Se aparecer erro em algum container, o output de `docker compose logs <nome-do-servico>`

## Bloco 2 (depois desse) — Expor Supabase via Traefik do EasyPanel
- Adicionar labels do Traefik no serviço `kong` do docker-compose
- Conectar container à rede do EasyPanel
- Validar `https://loginapi.fotonardo.com.br` com SSL

## Bloco 3 — Rodar migrations do CRM no banco novo
- Aplicar todas as migrations em ordem (via Studio ou `psql` no container)
- Criar bucket `whatsapp-media` + policies
- Configurar Auth (Site URL, redirect URLs, Google OAuth)

## Bloco 4 — Evolution API
- Redis + Evolution no EasyPanel apontando pro Postgres do Supabase
- Domínio + SSL

## Bloco 5 — App CRM
- Deploy via Git no EasyPanel com Dockerfile
- Build args (VITE_*) + env de runtime
- Domínio + SSL

## Bloco 6 — Amarração final
- Cadastrar conta admin no app
- Configurar credenciais Evolution em Configurações → WhatsApp
- Escanear QR
- Testar recebimento + envio + IA
- Cron de backup diário

---

Executa o **Bloco 1** e me manda o `docker compose ps`. Se travar em qualquer subpasso, cola o erro que eu destravo.
