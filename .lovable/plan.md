
## Consertar `.env` do Supabase self-hosted

O `.env` atual está quase vazio — faltam ~60 variáveis obrigatórias (POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, JWT_EXPIRY, KONG_HTTP_PORT, POOLER_*, STORAGE_*, etc.), por isso o container `supabase-db` fica reiniciando.

A correção é **restaurar o `.env.example` completo** e editar **apenas** as linhas que precisam de valores reais, deixando todo o resto (portas, hosts internos, defaults) como veio do repo oficial.

### Passos na VPS

**1. Restaurar o `.env` completo do repo oficial:**

```bash
cd /opt/supabase
curl -fsSL https://raw.githubusercontent.com/supabase/supabase/master/docker/.env.example -o .env
```

**2. Editar `.env` com `nano .env`** e alterar **somente estas linhas** (procure cada uma com Ctrl+W no nano). Deixe todas as outras variáveis intactas:

```env
POSTGRES_PASSWORD=<seu-postgres-password-gerado>
JWT_SECRET=<seu-jwt-secret-gerado>
ANON_KEY=<sua-anon-key-gerada>
SERVICE_ROLE_KEY=<sua-service-role-key-gerada>
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<uma-senha-forte-pra-voce>
SECRET_KEY_BASE=<seu-secret-key-base-gerado>
VAULT_ENC_KEY=<seu-vault-enc-key-gerado>

SITE_URL=https://login.fotonardo.com.br
ADDITIONAL_REDIRECT_URLS=https://login.fotonardo.com.br/**
API_EXTERNAL_URL=https://loginapi.fotonardo.com.br
SUPABASE_PUBLIC_URL=https://loginapi.fotonardo.com.br

STUDIO_DEFAULT_ORGANIZATION=Fotonardo
STUDIO_DEFAULT_PROJECT=CRM
```

Não mexa em: `POSTGRES_HOST`, `POSTGRES_DB`, `POSTGRES_PORT`, `KONG_HTTP_PORT`, `KONG_HTTPS_PORT`, `POOLER_*`, `PGRST_*`, `JWT_EXPIRY`, `MAILER_*`, `ENABLE_*`, `DISABLE_SIGNUP`, `S3_*`, `REGION`, `GLOBAL_S3_BUCKET`, `STORAGE_TENANT_ID`, `IMGPROXY_*`, `FUNCTIONS_VERIFY_JWT`, `PG_META_CRYPTO_KEY` — tudo isso já tem default correto no `.env.example`.

SMTP pode ficar com os valores default (só não conseguirá enviar email de confirmação — resolvemos depois).

**3. Zerar o volume corrompido do Postgres e subir de novo:**

```bash
cd /opt/supabase
docker compose down -v
docker compose up -d
```

`down -v` apaga o volume do banco (que ficou meio nascido com a config errada). Como não temos dados ainda, é seguro.

**4. Aguardar ~2min e checar:**

```bash
docker compose ps
```

Todos devem ficar `Up ... (healthy)`. Se algum ficar `Restarting`, roda:

```bash
docker compose logs <nome-do-servico> --tail 50
```

### O que me mandar

- Output final do `docker compose ps` (todos healthy?)
- Se algum não subir, logs desse serviço específico

Quando todos subirem, passo o Bloco 2 (expor `loginapi.fotonardo.com.br` via Traefik do EasyPanel com SSL).
