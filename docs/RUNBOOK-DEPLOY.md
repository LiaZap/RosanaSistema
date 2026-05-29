# FCE - Runbook de Deploy (EasyPanel + Hetzner)

## Pre-requisitos

- VPS Hetzner CX32 (4 vCPU, 8GB RAM, 80GB) com Ubuntu 22.04 LTS
- Dominio com DNS gerenciavel (Cloudflare ou Registro.br)
- EasyPanel instalado no servidor
- Chave Anthropic API (Claude) em maos
- Repo Git acessivel (GitHub, GitLab, etc.)

---

## Passo 1: Instalar EasyPanel (se ainda nao fez)

```bash
ssh root@SEU_IP

curl -sSL https://get.easypanel.io | sh
```

Acesse: `http://SEU_IP:3000` e crie usuario admin do EasyPanel.

---

## Passo 2: Configurar DNS

No Cloudflare (ou seu provedor DNS), crie os registros apontando para o IP do servidor:

| Tipo | Nome                    | Valor     | Proxy |
|------|-------------------------|-----------|-------|
| A    | fce.seudominio.com.br   | SEU_IP    | ON    |
| A    | api.fce.seudominio.com.br | SEU_IP  | ON    |
| A    | minio.fce.seudominio.com.br | SEU_IP | ON   |
| A    | admin.fce.seudominio.com.br | SEU_IP | ON   |

> Se usar Registro.br sem Cloudflare, desative "Proxy" (nao existe la). EasyPanel gera SSL via Let's Encrypt automaticamente.

---

## Passo 3: Clonar o repositorio no servidor

```bash
ssh root@SEU_IP

# Instalar Git se necessario
apt update && apt install -y git

# Clonar o projeto
cd /opt
git clone https://github.com/SEU_USER/ProjetoRosana.git fce
cd /opt/fce
```

---

## Passo 4: Gerar secrets

```bash
cd /opt/fce
chmod +x scripts/generate-secrets.sh
./scripts/generate-secrets.sh
```

Anote as senhas geradas. Agora crie o `.env` de producao:

```bash
cp .env.production.example .env
nano .env
```

Substitua TODOS os placeholders `{{CHANGE_ME}}`:

| Variavel | O que colocar |
|----------|---------------|
| `DOMAIN` | Seu dominio real (ex: `minhaloja.com.br`) |
| `FRONTEND_URL` | `https://fce.minhaloja.com.br` |
| `API_URL` | `https://api.fce.minhaloja.com.br` |
| `VITE_API_URL` | `/api` (manter assim, nginx faz proxy) |
| `POSTGRES_PASSWORD` | Senha gerada pelo script |
| `DATABASE_URL` | `postgresql://fce:SENHA_GERADA@postgres:5432/fce` |
| `MINIO_ROOT_PASSWORD` | Senha gerada pelo script |
| `MINIO_ENDPOINT` | `http://minio:9000` (interno ao Docker) |
| `COOKIE_DOMAIN` | `.fce.minhaloja.com.br` |
| `ANTHROPIC_API_KEY` | Sua chave `sk-ant-...` |

> **IMPORTANTE:** `MINIO_ENDPOINT` dentro do Docker e `http://minio:9000` (rede interna). O acesso externo ao MinIO Console sera via EasyPanel proxy.

---

## Passo 5: Build e subir os containers

```bash
cd /opt/fce
docker compose -f docker-compose.prod.yml up -d --build
```

Acompanhe os logs para ver se tudo subiu:

```bash
# Ver status
docker compose -f docker-compose.prod.yml ps

# Logs do backend (principal para debug)
docker compose -f docker-compose.prod.yml logs -f api

# Logs do worker
docker compose -f docker-compose.prod.yml logs -f worker

# Logs de tudo
docker compose -f docker-compose.prod.yml logs -f
```

Espere ate ver:
- `[API] FCE Backend v0.1.0 on http://localhost:3001`
- `[API] Postgres connected`
- `[Worker] All workers started`
- `[Worker] FCE Worker v0.1.0 ready`

---

## Passo 6: Rodar migrations do banco

```bash
# Entrar no container do backend
docker compose -f docker-compose.prod.yml exec api sh

# Dentro do container:
cd /app
node -e "
  const { migrate } = require('drizzle-orm/postgres-js/migrator');
  const postgres = require('postgres');
  const { drizzle } = require('drizzle-orm/postgres-js');
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);
  migrate(db, { migrationsFolder: './drizzle' })
    .then(() => { console.log('Migrations OK'); sql.end(); })
    .catch(e => { console.error(e); process.exit(1); });
"

# Ou se o build gerou o migrate script:
node dist/db/migrate.js

# Sair do container
exit
```

**Alternativa rapida** (rodar de fora):

```bash
docker compose -f docker-compose.prod.yml exec api node dist/db/migrate.js
```

Depois, rode o SQL das funcoes customizadas:

```bash
# Copiar o SQL para o container do postgres
docker compose -f docker-compose.prod.yml cp backend/src/db/functions.sql postgres:/tmp/functions.sql

# Executar
docker compose -f docker-compose.prod.yml exec postgres psql -U fce -d fce -f /tmp/functions.sql
```

---

## Passo 7: Criar bucket no MinIO

```bash
# Entrar no container do MinIO
docker compose -f docker-compose.prod.yml exec minio sh

# Criar o bucket
mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc mb local/fce-media
mc anonymous set download local/fce-media

# Sair
exit
```

**Alternativa** (com mc instalado no host):

```bash
docker compose -f docker-compose.prod.yml exec minio mc alias set local http://localhost:9000 fceadmin SUA_SENHA_MINIO
docker compose -f docker-compose.prod.yml exec minio mc mb local/fce-media
docker compose -f docker-compose.prod.yml exec minio mc anonymous set download local/fce-media
```

---

## Passo 8: Configurar EasyPanel como Reverse Proxy

EasyPanel nao vai gerenciar os containers (ja estao rodando via compose). Ele funciona como **reverse proxy + SSL terminator**.

### Opcao A: Usar Traefik direto (sem EasyPanel gerenciar)

Se preferir configurar tudo via EasyPanel UI:

1. Acesse `http://SEU_IP:3000` (painel EasyPanel)
2. Crie um novo projeto chamado `fce`
3. Para cada servico, crie um "Custom App" com proxy para a porta interna:

**Frontend (fce.seudominio.com.br)**:
- App type: Custom (Docker)
- Port: 3000 (a porta que o container `app` expoe)
- Domain: fce.seudominio.com.br
- SSL: Auto (Let's Encrypt)

### Opcao B: Labels Traefik no compose (recomendado)

Adicione labels no `docker-compose.prod.yml` para que o Traefik do EasyPanel detecte automaticamente. Edite o `.env`:

```bash
nano .env
# Adicione:
APP_PORT=3000
```

O EasyPanel usa Traefik internamente. Para integrar, voce precisa colocar os containers na mesma rede Docker que o EasyPanel usa. Execute:

```bash
# Descobrir a rede do EasyPanel
docker network ls | grep easypanel

# Conectar o container frontend na rede do EasyPanel
docker network connect easypanel fce-app-1

# Agora configure no EasyPanel UI:
# 1. Painel > Add Service > Custom
# 2. Container name: fce-app-1
# 3. Internal port: 80
# 4. Domain: fce.seudominio.com.br
# 5. Enable HTTPS
```

Repita para o MinIO Console se quiser acesso externo:
```bash
docker network connect easypanel fce-minio-1
# EasyPanel: Internal port 9001, domain: admin.fce.seudominio.com.br
```

### Opcao C: Caddy como proxy (alternativa simples)

Se EasyPanel der problema, instale Caddy direto:

```bash
apt install -y caddy

cat > /etc/caddy/Caddyfile <<'CADDYEOF'
fce.seudominio.com.br {
    reverse_proxy localhost:3000
}

admin.fce.seudominio.com.br {
    reverse_proxy localhost:9001
}
CADDYEOF

systemctl restart caddy
```

---

## Passo 9: Bootstrap do primeiro usuario

```bash
# 1. Acesse https://fce.seudominio.com.br
# 2. Clique em "Criar conta" e registre o admin
# 3. Depois, rode o SQL de bootstrap:

docker compose -f docker-compose.prod.yml exec postgres psql -U fce -d fce -c "
INSERT INTO accounts (name, slug)
VALUES ('FCE - Filhos com Estilo', 'fce')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO account_members (account_id, user_id, role, status)
SELECT
  (SELECT id FROM accounts WHERE slug = 'fce'),
  u.id,
  'owner',
  'active'
FROM users u
ORDER BY u.created_at ASC
LIMIT 1
ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner';
"
```

---

## Passo 10: Verificar saude do sistema

```bash
# Health check
curl -s https://api.fce.seudominio.com.br/health | python3 -m json.tool

# Ou via frontend proxy
curl -s https://fce.seudominio.com.br/api/health | python3 -m json.tool

# Verificar todos os containers
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=20
```

Resposta esperada do health:
```json
{
  "status": "ok",
  "postgres": true,
  "redis": true,
  "storage": true
}
```

---

## Passo 11: Configurar via UI

1. **Login** em `https://fce.seudominio.com.br`
2. **Settings > Agente** — Colar prompt DANI completo
3. **Settings > WhatsApp** — Conectar Evolution API (Server URL + API Key + Instance)
4. **Settings > Bling** — Credenciais + OAuth + primeira sincronizacao
5. **Teste real** — Enviar mensagem WhatsApp para o numero da loja

---

## Manutencao

### Atualizar o codigo

```bash
cd /opt/fce
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

### Ver logs em tempo real

```bash
docker compose -f docker-compose.prod.yml logs -f api worker
```

### Restart de um servico

```bash
docker compose -f docker-compose.prod.yml restart api
docker compose -f docker-compose.prod.yml restart worker
```

### Backup do banco

```bash
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U fce fce > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Restaurar backup

```bash
cat backup_YYYYMMDD.sql | docker compose -f docker-compose.prod.yml exec -T postgres psql -U fce fce
```

### Limpar imagens Docker antigas

```bash
docker system prune -af --volumes --filter "until=168h"
```

### Monitorar uso de recursos

```bash
docker stats --no-stream
```

Uso esperado no CX32 (4 vCPU, 8GB):

| Servico  | RAM esperado |
|----------|-------------|
| postgres | ~200-400MB  |
| redis    | ~50-100MB   |
| minio    | ~100-200MB  |
| api      | ~150-300MB  |
| worker   | ~150-300MB  |
| app      | ~30-50MB    |
| **Total**| **~700MB-1.3GB** |

Sobra RAM de sobra para picos.

---

## Troubleshooting

| Sintoma | Diagnostico | Fix |
|---------|-------------|-----|
| Container reiniciando | `docker logs fce-api-1` | Verificar DATABASE_URL no .env |
| 502 Bad Gateway | Container nao subiu | `docker compose ps` + restart |
| CORS error no browser | FRONTEND_URL errado | Ajustar no .env + restart api |
| Cookie nao persiste | COOKIE_DOMAIN errado | Deve ser `.fce.seudominio.com.br` |
| SSL nao funciona | DNS nao propagou | Esperar 5min, verificar `dig fce.seudominio.com.br` |
| MinIO access denied | Bucket nao criado | Passo 7 |
| Migration falhou | Container sem DATABASE_URL | Verificar .env |
| Worker nao processa | Redis nao conectou | Verificar REDIS_HOST=redis |
