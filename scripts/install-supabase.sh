#!/usr/bin/env bash
# =============================================================================
# install-supabase.sh — provisiona um projeto Supabase self-hosted isolado
#
# Uso:
#   ./install-supabase.sh <slug-projeto> <porta-kong-http> [porta-kong-https]
#
# Exemplo:
#   ./install-supabase.sh crm2 8100 8543
#
# Requisitos na VPS:
#   - docker + docker compose plugin
#   - git, curl, openssl, jq, python3
# =============================================================================
set -euo pipefail

PROJECT="${1:-}"
KONG_HTTP="${2:-8000}"
KONG_HTTPS="${3:-8443}"

if [[ -z "$PROJECT" ]]; then
  echo "uso: $0 <slug-projeto> <porta-kong-http> [porta-kong-https]" >&2
  exit 1
fi

TARGET="/opt/supabase-${PROJECT}"
if [[ -d "$TARGET" ]]; then
  echo "erro: $TARGET já existe. escolha outro slug ou remova o diretório." >&2
  exit 1
fi

echo ">>> [1/7] Instalando dependências mínimas"
command -v docker >/dev/null || { echo "docker não encontrado"; exit 1; }
command -v jq >/dev/null || apt-get update -y && apt-get install -y jq python3 python3-pip openssl git curl
python3 -c "import jwt" 2>/dev/null || pip3 install --quiet pyjwt

echo ">>> [2/7] Clonando docker/ do Supabase em $TARGET"
mkdir -p "$TARGET"
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/supabase/supabase.git "$tmp/supabase"
cp -R "$tmp/supabase/docker/." "$TARGET/"
rm -rf "$tmp"
cd "$TARGET"
cp .env.example .env

echo ">>> [3/7] Gerando segredos"
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 40)
SECRET_KEY_BASE=$(openssl rand -hex 32)
VAULT_ENC_KEY=$(openssl rand -hex 16)   # exatamente 32 chars
DASHBOARD_PASSWORD=$(openssl rand -hex 12)
LOGFLARE_PUBLIC=$(openssl rand -hex 16)
LOGFLARE_PRIVATE=$(openssl rand -hex 16)

echo ">>> [4/7] Assinando ANON_KEY e SERVICE_ROLE_KEY"
NOW=$(date +%s)
EXP=$((NOW + 60*60*24*365*10))  # 10 anos

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

echo ">>> [5/7] Escrevendo .env"
# Substitui os valores no .env preservando todas as demais variáveis
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

# URLs — o usuário edita depois se tiver domínio próprio; default = localhost:<porta>
sedi API_EXTERNAL_URL        "http://localhost:${KONG_HTTP}"
sedi SUPABASE_PUBLIC_URL     "http://localhost:${KONG_HTTP}"
sedi SITE_URL                "http://localhost:3000"
sedi ADDITIONAL_REDIRECT_URLS "http://localhost:3000"

sedi STUDIO_DEFAULT_ORGANIZATION "${PROJECT}"
sedi STUDIO_DEFAULT_PROJECT      "${PROJECT}"

# Autoconfirm email (dev — desligue em prod se for usar SMTP real)
grep -q '^ENABLE_EMAIL_AUTOCONFIRM=' .env \
  && sedi ENABLE_EMAIL_AUTOCONFIRM true \
  || echo "ENABLE_EMAIL_AUTOCONFIRM=true" >> .env

# Nome dos containers com prefixo do projeto pra não colidir
export COMPOSE_PROJECT_NAME="supabase_${PROJECT}"
echo "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}" > .compose-env

echo ">>> [6/7] Subindo stack (pode levar ~2min)"
docker compose --project-name "$COMPOSE_PROJECT_NAME" pull
docker compose --project-name "$COMPOSE_PROJECT_NAME" up -d

echo "aguardando Postgres ficar healthy..."
for i in {1..60}; do
  if docker exec "${COMPOSE_PROJECT_NAME}-db-1" pg_isready -U postgres >/dev/null 2>&1; then
    echo "postgres pronto"
    break
  fi
  sleep 3
done

echo ">>> [7/7] Aplicando migrations (opcional)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-}"
if [[ -n "$MIGRATIONS_DIR" && -d "$MIGRATIONS_DIR" ]]; then
  DB_CONTAINER="${COMPOSE_PROJECT_NAME}-db-1"
  for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
    echo "  -> aplicando $(basename "$f")"
    docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f"
  done
else
  echo "  (pule — defina MIGRATIONS_DIR=/caminho/pra/supabase/migrations pra aplicar automaticamente)"
fi

cat <<EOF

===============================================================================
PROJETO SUPABASE "${PROJECT}" PRONTO

Studio / API URL:   http://localhost:${KONG_HTTP}
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
  1. Apontar um subdomínio (ex: api-${PROJECT}.seudominio.com) pra porta ${KONG_HTTP}
     via Traefik/EasyPanel com HTTPS.
  2. Atualizar API_EXTERNAL_URL / SUPABASE_PUBLIC_URL / SITE_URL no
     ${TARGET}/.env e rodar:  docker compose --project-name ${COMPOSE_PROJECT_NAME} up -d
  3. Configurar seu app com:
       VITE_SUPABASE_URL=<URL pública>
       VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY acima>
       SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY acima>

Guarde essas chaves num cofre — o script NÃO salva em lugar nenhum além do .env.
===============================================================================
EOF
