# install-supabase.sh — instalador Supabase self-hosted (wizard)

Script interativo pra provisionar um projeto **Supabase self-hosted isolado** numa VPS que já roda **EasyPanel** (Traefik + Let's Encrypt). Cada execução cria um stack Docker independente (pasta, rede, containers e portas próprias), então dá pra ter vários projetos Supabase convivendo na mesma máquina.

---

## Pré-requisitos

- **VPS Linux** (Ubuntu 22.04+ testado) com acesso root/SSH.
- **EasyPanel instalado** — usado só pra publicar o Kong (API/Studio) num subdomínio com HTTPS via Traefik. Sem EasyPanel você teria que configurar Traefik/Nginx na mão.
- **Docker + docker compose plugin** (o EasyPanel já instala).
- Utilitários: `git`, `curl`, `openssl`, `jq`, `python3` (o script instala o que faltar).
- **DNS** apontado antes de rodar: um subdomínio A record → IP da VPS (ex: `api-crm2.seudominio.com`).
- Repo GitHub do app (opcional) com as migrations em `supabase/migrations/*.sql`.

---

## Como rodar

Na VPS, como root:

```bash
curl -fsSL https://raw.githubusercontent.com/<seu-usuario>/<seu-repo>/main/scripts/install-supabase.sh -o install-supabase.sh
sudo bash install-supabase.sh
```

Ou clone o repo e rode direto: `sudo bash scripts/install-supabase.sh`.

---

## O que o wizard pergunta

| Pergunta | O que é | Exemplo |
|---|---|---|
| **Slug do projeto** | Identificador único do stack. Vira nome de pasta (`/opt/supabase-<slug>`) e prefixo dos containers. Use `[a-z0-9_-]`. | `crm2` |
| **Porta HTTP do Kong** | Porta local onde o Kong (API + Studio) escuta HTTP. O Traefik do EasyPanel vai apontar pra ela. | `8100` |
| **Porta HTTPS do Kong** | Porta local do Kong HTTPS (raramente usada — o TLS fica no Traefik). | `8543` |
| **Porta do Postgres no host** | Porta do supavisor (session pooler) publicada no host. **Cada projeto precisa de uma diferente.** | `5432`, `5532`, `5632`… |
| **Porta do pooler no host** | Porta do supavisor transaction. **Também precisa ser única por projeto.** | `6543`, `6643`, `6743`… |
| **Porta do analytics** | Logflare/analytics. Diferente por projeto se houver conflito. | `4000`, `4100`… |
| **URL do repositório GitHub** | Repo com migrations. Deixe em branco pra pular. Aceita `https://…git` ou `git@github.com:…`. | `https://github.com/user/crm.git` |
| **Branch** | Branch do repo. | `main` |
| **Subpasta com .sql** | Onde ficam as migrations dentro do repo. | `supabase/migrations` |
| **URL pública da API** | Vira `API_EXTERNAL_URL` / `SUPABASE_PUBLIC_URL`. Use `https://...` para ativar a integração automática com Traefik. | `https://api-crm2.seudominio.com` |
| **SITE_URL** | URL do frontend (usada em redirects do Auth). | `https://crm2.seudominio.com` |
| **Publicar Kong via Traefik?** | Se sim, o script gera `docker-compose.override.yml` com labels do Traefik e conecta o Kong à rede do EasyPanel — não precisa criar App proxy no EasyPanel. | `y` |
| **Rede Traefik do EasyPanel** | Nome da rede docker externa onde o Traefik do EasyPanel escuta. Confira com `docker network ls`. | `easypanel-traefik` |
| **Entrypoint HTTPS** | Nome do entrypoint HTTPS no Traefik. | `websecure` |
| **Cert resolver** | Nome do resolver Let's Encrypt configurado no Traefik do EasyPanel. | `letsencrypt` |

---

## Já existe um projeto Supabase na VPS? Cuidado com portas

Todo stack Supabase publica portas fixas no host por padrão:

| Serviço | Porta padrão |
|---|---|
| Kong HTTP | 8000 |
| Kong HTTPS | 8443 |
| Supavisor (session) | 5432 |
| Supavisor (transaction) | 6543 |
| Analytics | 4000 |

Se você já tem um projeto rodando, **essas portas estão ocupadas** e o segundo stack quebra com:

```
Bind for 0.0.0.0:5432 failed: port is already allocated
```

**Como checar antes de rodar o wizard:**

```bash
ss -tlnp | grep -E ':(8000|8100|8443|5432|5532|6543|6643|4000|4100)\s'
# ou
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -E '5432|6543|8000'
```

**Escolha portas livres** em cada pergunta do wizard — sugestão: incremente 100 a cada projeto (`8100`/`5532`/`6643`/`4100` pro segundo, `8200`/`5632`/`6743`/`4200` pro terceiro, etc.). O wizard já sugere defaults não-conflitantes com o padrão.

O script também remove `container_name:` fixos do `docker-compose.yml` (ex: `supabase-imgproxy`), senão o Docker recusa criar containers com nomes duplicados.

---

## O que o script faz por baixo

1. Instala dependências que faltarem (`jq`, `git`, `python3`, `pyjwt`).
2. Clona `github.com/supabase/supabase` (só `/docker/`) em `/opt/supabase-<slug>`.
3. Gera segredos com `openssl`: `POSTGRES_PASSWORD`, `JWT_SECRET`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `DASHBOARD_PASSWORD`, tokens do Logflare.
4. Assina `ANON_KEY` e `SERVICE_ROLE_KEY` (JWT HS256, validade 10 anos) usando o `JWT_SECRET` gerado.
5. Escreve tudo no `.env` do projeto.
6. Remove `container_name:` fixos do compose (evita colisão entre stacks).
7. Sobe o stack: `docker compose --project-name supabase_<slug> up -d`.
8. Espera o Postgres ficar healthy e, se você deu um repo GitHub, clona e aplica todos os `.sql` da subpasta em ordem alfabética via `psql`.
9. Imprime no final o resumo com **ANON_KEY, SERVICE_ROLE_KEY, senha do Studio e do Postgres** — guarda isso, elas só existem no `.env` do diretório.

---

## Após a instalação

### 1. Expor Kong via EasyPanel (HTTPS)

Sem esse passo o Supabase só responde em `http://IP:<KONG_HTTP>`.

1. EasyPanel → seu Project → **+ Service → App**.
2. Nome: `supabase-<slug>-proxy` (só um placeholder).
3. **Domain** → adicione `api-<slug>.seudominio.com` → **HTTPS** + **Let's Encrypt**.
4. **Proxy port** = a porta que você escolheu em `KONG_HTTP` (ex: `8100`).
5. Salvar. Em ~1min o Traefik emite o cert e o subdomínio responde.

Teste:
```bash
curl -i https://api-<slug>.seudominio.com/rest/v1/
# esperado: HTTP/2 401 (sem apikey — significa que o Kong está atendendo)
```

### 2. Atualizar `.env` com o domínio público

Se você não colocou a URL final no wizard, edite agora:

```bash
cd /opt/supabase-<slug>
sed -i 's|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=https://api-<slug>.seudominio.com|' .env
sed -i 's|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=https://api-<slug>.seudominio.com|' .env
sed -i 's|^SITE_URL=.*|SITE_URL=https://<app>.seudominio.com|' .env
docker compose --project-name supabase_<slug> up -d
```

### 3. Abrir o Studio

`https://api-<slug>.seudominio.com` → login: `admin` / `DASHBOARD_PASSWORD` (imprime no final da instalação; também está no `.env`).

### 4. Configurar Auth

Studio → **Authentication → URL Configuration**:
- Site URL: `https://<app>.seudominio.com`
- Redirect URLs: `https://<app>.seudominio.com/**`

Studio → **Authentication → Providers** → habilite os providers que for usar (Email já vem ligado; Google/etc. exigem Client ID + Secret).

### 5. Criar buckets de Storage (se o app usar)

Studio → **Storage → New bucket** → nome + público/privado. Adicione policies conforme necessário.

### 6. Configurar o app

No `.env` do frontend:
```env
VITE_SUPABASE_URL=https://api-<slug>.seudominio.com
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY do resumo>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY do resumo>  # só server-side
```

### 7. Backup diário (recomendado)

```bash
cat >/etc/cron.daily/supabase-<slug>-backup <<'SH'
#!/bin/bash
mkdir -p /opt/backups
docker exec supabase_<slug>-db-1 pg_dumpall -U postgres \
  | gzip > /opt/backups/supabase-<slug>-$(date +\%F).sql.gz
find /opt/backups -name 'supabase-<slug>-*.sql.gz' -mtime +14 -delete
SH
chmod +x /etc/cron.daily/supabase-<slug>-backup
```

---

## Aplicar migrations depois (sem re-rodar o wizard)

```bash
cd /opt/supabase-<slug>
git clone --depth 1 https://github.com/user/repo.git /tmp/repo
for f in $(ls /tmp/repo/supabase/migrations/*.sql | sort); do
  echo ">> $f"
  docker exec -i supabase_<slug>-db-1 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f"
done
rm -rf /tmp/repo
```

---

## Comandos úteis

```bash
# ver status
docker compose --project-name supabase_<slug> ps

# logs de um serviço
docker compose --project-name supabase_<slug> logs -f auth

# reiniciar após editar .env
docker compose --project-name supabase_<slug> up -d

# derrubar tudo (mantém volumes/dados)
docker compose --project-name supabase_<slug> down

# derrubar E APAGAR volumes (⚠️ perde o banco)
docker compose --project-name supabase_<slug> down -v

# psql direto no banco
docker exec -it supabase_<slug>-db-1 psql -U postgres
```

---

## Troubleshooting

**`Bind for 0.0.0.0:XXXX failed: port is already allocated`** — outra instância usa a porta. Rode `ss -tlnp | grep XXXX`, escolha porta livre e edite `.env` (`POSTGRES_PORT`, `POOLER_PROXY_PORT_TRANSACTION`, `KONG_HTTP_PORT`, `ANALYTICS_HOST_PORT`) → `docker compose … up -d`.

**`container name "/supabase-xxx" is already in use`** — o compose oficial tem `container_name:` fixo. O wizard remove automaticamente; se você editou o compose depois, rode: `sed -i '/^\s*container_name:/d' /opt/supabase-<slug>/docker-compose.yml`.

**Studio não abre / erro 502 no domínio** — confira se o EasyPanel App está apontando pra porta correta (`KONG_HTTP`) e se o container do Kong está `healthy` (`docker compose … ps`).

**Signup falha com "Database error saving new user"** — falta migration do `handle_new_user` trigger. Aplique as migrations do repo (passo acima).

**`ANON_KEY inválida` no app** — cada projeto tem `JWT_SECRET` próprio, então `ANON_KEY` também. Nunca reuse chave de outro projeto. Elas estão no `.env` do stack.

**Perdi as chaves** — abra `/opt/supabase-<slug>/.env`: `ANON_KEY`, `SERVICE_ROLE_KEY`, `DASHBOARD_PASSWORD`, `POSTGRES_PASSWORD` estão todos lá.
