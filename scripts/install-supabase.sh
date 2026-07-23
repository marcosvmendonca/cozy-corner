#!/usr/bin/env bash
# =============================================================================
# install-supabase.sh — wizard interativo para provisionar um projeto Supabase
# self-hosted isolado + aplicar migrations vindas de um repo GitHub.
#
# Uso:
#   sudo bash install-supabase.sh
#
# O script pergunta:
#   - slug do projeto (ex: crm2)
#   - porta HTTP do Kong (ex: 8100)
#   - porta HTTPS do Kong (ex: 8543)
#   - URL do repo GitHub (opcional) — usa a pasta supabase/migrations dele
#   - branch (default: main)
#
# Requisitos na VPS:
#   docker + docker compose plugin, git, curl, openssl, jq, python3
# =============================================================================
set -euo pipefail

# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
ask() {
  # ask "Pergunta" "default" -> ecoa resposta (ou default)
  local prompt="$1" default="${2:-}" reply
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " reply || true
    echo "${reply:-$default}"
  else
    while true; do
      read -rp "  $prompt: " reply || true
      if [[ -n "$reply" ]]; then echo "$reply"; return; fi
      echo "  (obrigatório)" >&2
    done
  fi
}

ask_yn() {
  local prompt="$1" default="${2:-n}" reply
  read -rp "  $prompt [${default}]: " reply || true
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[yYsS]$ ]]
}

section() { echo; echo ">>> $*"; }

# ----------------------------------------------------------------------------
# wizard
# ----------------------------------------------------------------------------
cat <<'BANNER'
===============================================================================
  Supabase self-hosted — instalador interativo
===============================================================================
BANNER

echo
echo "Responda as perguntas abaixo (Enter aceita o valor padrão entre colchetes)."
echo

PROJECT=$(ask "Slug do projeto (letras minúsculas, sem espaço, ex: crm2)")
if [[ ! "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "erro: slug inválido. use apenas [a-z0-9_-]." >&2
  exit 1
fi

KONG_HTTP=$(ask  "Porta HTTP do Kong"  "8100")
KONG_HTTPS=$(ask "Porta HTTPS do Kong" "8543")
POSTGRES_PORT_HOST=$(ask "Porta do Postgres no host (supavisor session)"     "5532")
POOLER_PORT_HOST=$(ask   "Porta do pooler no host (supavisor transaction)"   "6643")
ANALYTICS_PORT_HOST=$(ask "Porta do analytics/logflare no host"              "4100")

echo
echo "Se você tem um repo GitHub com migrations em supabase/migrations,"
echo "cole a URL (https://github.com/usuario/repo.git ou git@github.com:...)."
echo "Deixe em branco pra pular."
GH_URL=$(ask "URL do repositório GitHub" " ")
GH_URL="${GH_URL// /}"

GH_BRANCH=""
GH_SUBDIR="supabase/migrations"
if [[ -n "$GH_URL" ]]; then
  GH_BRANCH=$(ask "Branch" "main")
  GH_SUBDIR=$(ask "Subpasta com os .sql de migration" "supabase/migrations")
fi

API_URL_DEFAULT="http://localhost:${KONG_HTTP}"
API_URL=$(ask "URL pública da API (ex: https://api-${PROJECT}.seudominio.com)" "$API_URL_DEFAULT")
SITE_URL=$(ask "SITE_URL (frontend)" "http://localhost:3000")

echo
echo "Traefik/EasyPanel — o script pode gerar um docker-compose.override.yml"
echo "com labels do Traefik pra publicar o Kong direto via HTTPS, sem precisar"
echo "criar um App proxy no EasyPanel. Requer que a URL pública seja https://..."
USE_TRAEFIK="n"
TRAEFIK_NETWORK=""
TRAEFIK_CERTRESOLVER=""
TRAEFIK_ENTRYPOINT=""
TRAEFIK_HOST=""
if [[ "$API_URL" =~ ^https://([^/]+) ]]; then
  TRAEFIK_HOST="${BASH_REMATCH[1]}"
  if ask_yn "Publicar Kong via Traefik (labels no compose)?" "y"; then
    USE_TRAEFIK="y"
    TRAEFIK_NETWORK=$(ask   "Nome da rede Traefik do EasyPanel"   "easypanel-traefik")
    TRAEFIK_ENTRYPOINT=$(ask "Entrypoint HTTPS do Traefik"         "websecure")
    TRAEFIK_CERTRESOLVER=$(ask "Cert resolver (Let's Encrypt)"     "letsencrypt")
  fi
fi


TARGET="/opt/supabase-${PROJECT}"
if [[ -d "$TARGET" ]]; then
  echo "erro: $TARGET já existe. escolha outro slug ou remova o diretório." >&2
  exit 1
fi

echo
echo "Resumo:"
echo "  projeto:     $PROJECT"
echo "  diretório:   $TARGET"
echo "  kong http:   $KONG_HTTP"
echo "  kong https:  $KONG_HTTPS"
echo "  api url:     $API_URL"
echo "  site url:    $SITE_URL"
if [[ "$USE_TRAEFIK" == "y" ]]; then
  echo "  traefik:     host=$TRAEFIK_HOST rede=$TRAEFIK_NETWORK entry=$TRAEFIK_ENTRYPOINT resolver=$TRAEFIK_CERTRESOLVER"
else
  echo "  traefik:     (desabilitado — publique o Kong manualmente)"
fi
if [[ -n "$GH_URL" ]]; then
  echo "  github:      $GH_URL ($GH_BRANCH) — migrations em $GH_SUBDIR"
else
  echo "  github:      (nenhum — pula migrations)"
fi
echo
ask_yn "Confirma e prossegue?" "y" || { echo "cancelado."; exit 0; }

# ----------------------------------------------------------------------------
# dependências
# ----------------------------------------------------------------------------
section "[1/7] Verificando dependências"
command -v docker >/dev/null || { echo "docker não encontrado"; exit 1; }
command -v jq >/dev/null || { apt-get update -y && apt-get install -y jq; }
command -v git >/dev/null || apt-get install -y git
command -v openssl >/dev/null || apt-get install -y openssl
command -v python3 >/dev/null || apt-get install -y python3 python3-pip
python3 -c "import jwt" 2>/dev/null || pip3 install --quiet pyjwt

# ----------------------------------------------------------------------------
# clona docker/ do supabase
# ----------------------------------------------------------------------------
section "[2/7] Clonando docker/ do Supabase em $TARGET"
mkdir -p "$TARGET"
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/supabase/supabase.git "$tmp/supabase"
cp -R "$tmp/supabase/docker/." "$TARGET/"
rm -rf "$tmp"
cd "$TARGET"
cp .env.example .env

# ----------------------------------------------------------------------------
# segredos
# ----------------------------------------------------------------------------
section "[3/7] Gerando segredos"
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 40)
SECRET_KEY_BASE=$(openssl rand -hex 32)
VAULT_ENC_KEY=$(openssl rand -hex 16)
DASHBOARD_PASSWORD=$(openssl rand -hex 12)
LOGFLARE_PUBLIC=$(openssl rand -hex 16)
LOGFLARE_PRIVATE=$(openssl rand -hex 16)

section "[4/7] Assinando ANON_KEY e SERVICE_ROLE_KEY"
NOW=$(date +%s)
EXP=$((NOW + 60*60*24*365*10))

ANON_KEY=$(JWT_SECRET="$JWT_SECRET" IAT="$NOW" EXP="$EXP" python3 - <<'PY'
import os, jwt
print(jwt.encode(
  {"role":"anon","iss":"supabase","iat":int(os.environ["IAT"]),"exp":int(os.environ["EXP"])},
  os.environ["JWT_SECRET"], algorithm="HS256"))
PY
)
SERVICE_ROLE_KEY=$(JWT_SECRET="$JWT_SECRET" IAT="$NOW" EXP="$EXP" python3 - <<'PY'
import os, jwt
print(jwt.encode(
  {"role":"service_role","iss":"supabase","iat":int(os.environ["IAT"]),"exp":int(os.environ["EXP"])},
  os.environ["JWT_SECRET"], algorithm="HS256"))
PY
)

# ----------------------------------------------------------------------------
# .env
# ----------------------------------------------------------------------------
section "[5/7] Escrevendo .env"
sedi() { sed -i "s|^${1}=.*|${1}=${2}|" .env; }

sedi POSTGRES_PASSWORD       "$POSTGRES_PASSWORD"
sedi JWT_SECRET              "$JWT_SECRET"
sedi ANON_KEY                "$ANON_KEY"
sedi SERVICE_ROLE_KEY        "$SERVICE_ROLE_KEY"
sedi DASHBOARD_USERNAME      "admin"
sedi DASHBOARD_PASSWORD      "$DASHBOARD_PASSWORD"
sedi SECRET_KEY_BASE         "$SECRET_KEY_BASE"
sedi VAULT_ENC_KEY           "$VAULT_ENC_KEY"
sedi KONG_HTTP_PORT          "$KONG_HTTP"
sedi KONG_HTTPS_PORT         "$KONG_HTTPS"
sedi LOGFLARE_PUBLIC_ACCESS_TOKEN  "$LOGFLARE_PUBLIC"
sedi LOGFLARE_PRIVATE_ACCESS_TOKEN "$LOGFLARE_PRIVATE"

# portas do host (evita colisão entre múltiplos stacks supabase na mesma VPS)
if grep -q '^POSTGRES_PORT=' .env; then sedi POSTGRES_PORT "$POSTGRES_PORT_HOST"; else echo "POSTGRES_PORT=${POSTGRES_PORT_HOST}" >> .env; fi
if grep -q '^POOLER_PROXY_PORT_TRANSACTION=' .env; then sedi POOLER_PROXY_PORT_TRANSACTION "$POOLER_PORT_HOST"; else echo "POOLER_PROXY_PORT_TRANSACTION=${POOLER_PORT_HOST}" >> .env; fi
if grep -q '^ANALYTICS_HOST_PORT=' .env; then sedi ANALYTICS_HOST_PORT "$ANALYTICS_PORT_HOST"; fi

sedi API_EXTERNAL_URL        "$API_URL"
sedi SUPABASE_PUBLIC_URL     "$API_URL"
sedi SITE_URL                "$SITE_URL"
sedi ADDITIONAL_REDIRECT_URLS "$SITE_URL"

sedi STUDIO_DEFAULT_ORGANIZATION "${PROJECT}"
sedi STUDIO_DEFAULT_PROJECT      "${PROJECT}"

grep -q '^ENABLE_EMAIL_AUTOCONFIRM=' .env \
  && sedi ENABLE_EMAIL_AUTOCONFIRM true \
  || echo "ENABLE_EMAIL_AUTOCONFIRM=true" >> .env

export COMPOSE_PROJECT_NAME="supabase_${PROJECT}"
echo "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}" > .compose-env

# Remove `container_name:` fixos do compose (senão colide com outros projetos
# supabase já rodando na mesma VPS — ex: supabase-imgproxy já em uso).
# Sem essa linha, o docker gera nomes prefixados com $COMPOSE_PROJECT_NAME.
if grep -q '^\s*container_name:' docker-compose.yml; then
  echo "  removendo container_name fixos do docker-compose.yml (evita colisão entre projetos)"
  sed -i '/^\s*container_name:/d' docker-compose.yml
fi

# ----------------------------------------------------------------------------
# sobe stack
# ----------------------------------------------------------------------------
section "[6/7] Subindo stack (pode levar ~2min)"
docker compose --project-name "$COMPOSE_PROJECT_NAME" pull
docker compose --project-name "$COMPOSE_PROJECT_NAME" up -d

echo "  aguardando Postgres ficar healthy..."
DB_CONTAINER="${COMPOSE_PROJECT_NAME}-db-1"

for i in {1..60}; do
  if docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
    echo "  postgres pronto"
    break
  fi
  sleep 3
done

# ----------------------------------------------------------------------------
# migrations do GitHub
# ----------------------------------------------------------------------------
section "[7/7] Aplicando migrations"
if [[ -n "$GH_URL" ]]; then
  repo_tmp=$(mktemp -d)
  echo "  clonando $GH_URL (branch $GH_BRANCH)..."
  if ! git clone --depth 1 --branch "$GH_BRANCH" "$GH_URL" "$repo_tmp/repo"; then
    echo "  ERRO ao clonar o repo. pule esta etapa ou rode manualmente depois." >&2
  else
    MIG_DIR="$repo_tmp/repo/$GH_SUBDIR"
    if [[ ! -d "$MIG_DIR" ]]; then
      echo "  aviso: pasta $GH_SUBDIR não existe no repo. nada foi aplicado."
    else
      shopt -s nullglob
      files=( "$MIG_DIR"/*.sql )
      if (( ${#files[@]} == 0 )); then
        echo "  aviso: nenhum .sql em $GH_SUBDIR."
      else
        IFS=$'\n' sorted=($(sort <<<"${files[*]}")); unset IFS
        for f in "${sorted[@]}"; do
          echo "  -> aplicando $(basename "$f")"
          if ! docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f"; then
            echo "  ERRO em $(basename "$f"). interrompendo migrations." >&2
            break
          fi
        done
      fi
    fi
    rm -rf "$repo_tmp"
  fi
else
  echo "  (nenhum repo informado — pule)"
fi

# ----------------------------------------------------------------------------
# resumo final
# ----------------------------------------------------------------------------
cat <<EOF

===============================================================================
PROJETO SUPABASE "${PROJECT}" PRONTO

Studio / API URL:   ${API_URL}
Studio login:       admin / ${DASHBOARD_PASSWORD}

ANON_KEY:
${ANON_KEY}

SERVICE_ROLE_KEY:
${SERVICE_ROLE_KEY}

POSTGRES_PASSWORD:  ${POSTGRES_PASSWORD}
JWT_SECRET:         ${JWT_SECRET}

Diretório:          ${TARGET}
Compose project:    ${COMPOSE_PROJECT_NAME}

Próximos passos:
  1. Apontar subdomínio (ex: api-${PROJECT}.seudominio.com) pra porta ${KONG_HTTP}
     via Traefik/EasyPanel com HTTPS.
  2. Se mudar o domínio público, edite API_EXTERNAL_URL / SUPABASE_PUBLIC_URL /
     SITE_URL em ${TARGET}/.env e rode:
       docker compose --project-name ${COMPOSE_PROJECT_NAME} up -d
  3. No app, configure:
       VITE_SUPABASE_URL=<URL pública>
       VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY acima>
       SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY acima>

Guarde as chaves — elas só existem no .env deste diretório.
===============================================================================
EOF
