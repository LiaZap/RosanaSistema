# FCE — Setup com Claude Code + EasyPanel

> **Guia de migração** do Lovable para uma stack self-hosted no EasyPanel, mantendo o mesmo blueprint do `CLAUDE.md`.

---

## 🏗️ ARQUITETURA ADAPTADA

```
┌─────────────────────────────────────────────────────────────────┐
│                       SEU EASYPANEL                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌─────────────┐  ┌─────────────────────┐    │
│  │  fce-app     │  │  evolution  │  │  fce-cron-worker    │    │
│  │  (Nginx +    │  │  (já existe)│  │  (Node, dispara     │    │
│  │   Vite dist) │  │             │  │   sync a cada 5h)   │    │
│  └──────┬───────┘  └──────┬──────┘  └──────────┬──────────┘    │
│         │                  │                    │                │
└─────────┼──────────────────┼────────────────────┼────────────────┘
          │                  │                    │
          └──────────────────┼────────────────────┘
                             ↓
              ┌──────────────────────────────────┐
              │       SUPABASE CLOUD (free)      │
              │  - PostgreSQL                    │
              │  - Auth                          │
              │  - Edge Functions (Deno runtime) │
              │  - Storage                       │
              │  - Realtime                      │
              └──────────────────────────────────┘
```

**Por que Supabase Cloud e não self-hosted?**
- Edge Functions usam **Deno runtime** que é complicado de hostear isolado
- Auth + RLS já vêm prontos
- Free tier dá 500MB DB + 1GB storage + 2M edge function invocations
- Quando crescer, paga $25/mês (Pro) e tá tranquilo
- Se for self-hosted total, precisa Supabase Self-Hosted Docker stack (complexo)

**Alternativa 100% self-hosted:** ver final do documento.

---

## 📦 ESTRUTURA DE CONTAINERS NO EASYPANEL

### Container 1: `fce-app` (Frontend React)

**Dockerfile** (`./Dockerfile`):

```dockerfile
# ===== Stage 1: Build =====
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Recebe env vars no momento do build (Vite precisa de variáveis no build)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PROJECT_ID
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_PROJECT_ID=$VITE_SUPABASE_PROJECT_ID

RUN npm run build

# ===== Stage 2: Production (Nginx) =====
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**nginx.conf** (`./nginx.conf`):

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA — todas as rotas caem no index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache agressivo de assets com hash
    location ~* \.(?:css|js|jpg|jpeg|png|svg|webp|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Compressão
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_min_length 1000;

    # Segurança
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

**EasyPanel — Configuração do serviço:**
- **Type**: App (custom Dockerfile)
- **Source**: GitHub repo (auto-deploy on push)
- **Port**: 80
- **Domain**: `fce.seudominio.com.br` (com Let's Encrypt automático)
- **Build Args**:
  - `VITE_SUPABASE_URL=https://xxxxx.supabase.co`
  - `VITE_SUPABASE_PUBLISHABLE_KEY=eyJxxx...`
  - `VITE_SUPABASE_PROJECT_ID=xxxxx`

---

### Container 2: `fce-cron-worker` (Scheduler)

Como o EasyPanel não tem cron nativo, criamos um worker em Node.js que dispara as Edge Functions na hora certa.

**Dockerfile** (`./worker/Dockerfile`):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "cron.js"]
```

**worker/package.json**:

```json
{
  "name": "fce-cron-worker",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "node-cron": "^3.0.3",
    "node-fetch": "^3.3.2"
  }
}
```

**worker/cron.js**:

```javascript
import cron from 'node-cron';
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function callFunction(name, body = {}) {
  console.log(`[Cron] Calling ${name} at ${new Date().toISOString()}`);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log(`[Cron] ${name} response:`, data);
  } catch (err) {
    console.error(`[Cron] ${name} error:`, err);
  }
}

// Sync catálogo Bling a cada 5 horas
cron.schedule('0 */5 * * *', () => callFunction('bling-catalog-sync'));

// Processa fila DANI a cada 30 segundos (backup, caso webhook falhe)
cron.schedule('*/30 * * * * *', () => callFunction('trigger-nina-orchestrator'));

// Envia fila WhatsApp a cada 10 segundos
cron.schedule('*/10 * * * * *', () => callFunction('whatsapp-sender', { triggered_by: 'cron' }));

console.log('[Cron] Worker started. Scheduled jobs:');
console.log('  - bling-catalog-sync: a cada 5h');
console.log('  - trigger-nina-orchestrator: a cada 30s');
console.log('  - whatsapp-sender: a cada 10s');
```

**EasyPanel:**
- **Type**: App
- **Port**: nenhum (worker, sem HTTP)
- **Env vars**:
  - `SUPABASE_URL=https://xxxxx.supabase.co`
  - `SUPABASE_SERVICE_ROLE_KEY=eyJxxx...`

---

### Container 3: `evolution-api` (já existe)

A Rosana já tem em `https://mythicallamprey-evolution.cloudfy.live`. Mantém. Só precisa atualizar o webhook URL pro novo backend:

```
Webhook URL: https://xxxxx.supabase.co/functions/v1/whatsapp-webhook
Events: messages.upsert, messages.update, connection.update
```

---

## 🗄️ SUPABASE CLOUD (Backend)

### Setup inicial

1. Acesse https://supabase.com → New Project
2. Nome: `fce-rosana`
3. Region: `South America (São Paulo)` (sa-east-1)
4. Database password: senha forte (anota!)
5. Plan: Free (depois Pro $25/mês quando precisar)

### Aplicar migrations

```bash
# Instala Supabase CLI
npm install -g supabase

# Login
supabase login

# Linka o projeto local com o cloud
cd D:/RosanaSistema
supabase link --project-ref xxxxx

# Aplica migrations
supabase db push
```

Ou pelo Dashboard:
1. SQL Editor → Cole conteúdo de cada arquivo `supabase/migrations/*.sql` na ordem
2. Run

### Deploy Edge Functions

```bash
# Deploy de TODAS de uma vez
supabase functions deploy --no-verify-jwt

# Ou função por função
supabase functions deploy nina-orchestrator
supabase functions deploy whatsapp-webhook
supabase functions deploy bling-catalog-sync
supabase functions deploy product-search
supabase functions deploy bling-auth
supabase functions deploy cloudinary-auth
supabase functions deploy bling-cloudinary-upload
supabase functions deploy whatsapp-sender
supabase functions deploy message-grouper
supabase functions deploy trigger-nina-orchestrator
supabase functions deploy initialize-system
supabase functions deploy account-invite
supabase functions deploy send-transactional-email
supabase functions deploy analyze-conversation
supabase functions deploy google-calendar-auth
supabase functions deploy whatsapp-session-create
supabase functions deploy whatsapp-session-connect
supabase functions deploy super-admin-create-client
supabase functions deploy send-invite-email
supabase functions deploy health-check
```

### Configurar Secrets

```bash
# Configura via CLI
supabase secrets set LOVABLE_API_KEY=sk-xxxx
supabase secrets set RESEND_API_KEY=re_xxxx
supabase secrets set GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
supabase secrets set GOOGLE_CLIENT_SECRET=xxx

# Ou pelo Dashboard: Project Settings → Edge Functions → Secrets
```

**Importante sobre `LOVABLE_API_KEY`:**
- Se sair do Lovable, precisa de outra API. Opções:
  - **OpenRouter** (compatível com OpenAI): `https://openrouter.ai/api/v1/chat/completions`
  - **Google AI Studio** (Gemini direto): `https://generativelanguage.googleapis.com/v1beta/models/...`
  - **OpenAI**: `https://api.openai.com/v1/chat/completions`
  - **Anthropic**: `https://api.anthropic.com/v1/messages` (Claude — sua escolha óbvia)

Vou te dar adaptação pra cada uma abaixo.

---

## 🔄 SUBSTITUIR LOVABLE AI GATEWAY → CLAUDE API

Como você vai usar Claude Code, faz sentido usar **Claude API** direto na DANI também.

### Modificar `nina-orchestrator/index.ts`

```typescript
// Remover:
// const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

// Adicionar:
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Trocar chamada AI:
const aiResponse = await fetch(ANTHROPIC_API_URL, {
  method: 'POST',
  headers: {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: processedPrompt,  // System prompt vai num campo separado
    messages: conversationHistory,
    tools: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,  // schema vira input_schema no Anthropic
    })),
  }),
});

const aiData = await aiResponse.json();
// Estrutura de resposta do Anthropic é diferente:
// aiData.content é um array, com blocos do tipo 'text' ou 'tool_use'
const textBlocks = aiData.content.filter(c => c.type === 'text');
const toolBlocks = aiData.content.filter(c => c.type === 'tool_use');

let aiContent = textBlocks.map(b => b.text).join('\n');
const toolCalls = toolBlocks.map(b => ({
  function: {
    name: b.name,
    arguments: JSON.stringify(b.input),
  }
}));
```

**Modelos Claude disponíveis:**
- `claude-sonnet-4-5-20250929` — balanced, recomendado
- `claude-opus-4-5-20250929` — mais inteligente, mais caro
- `claude-haiku-4-5-20250929` — rápido e barato

**Custos aproximados (Sonnet 4.5):**
- Input: $3 / 1M tokens
- Output: $15 / 1M tokens
- Cache: 90% desconto após primeiro hit (essencial pra prompt de 46KB da DANI)

**Com prompt caching:**
```typescript
messages: [
  ...conversationHistory,
],
system: [
  {
    type: 'text',
    text: processedPrompt,
    cache_control: { type: 'ephemeral' }  // Cacheia o prompt!
  }
],
```

Isso reduz custo de 90% das chamadas (só pagas pela conversa que muda, não pelos 46KB do prompt da DANI).

---

## 🚀 SETUP STEP-BY-STEP NO CLAUDE CODE + EASYPANEL

### Passo 1: Criar projeto local com Claude Code

```bash
# Cria pasta nova
mkdir fce-rosana
cd fce-rosana

# Inicia Claude Code
claude

# Cole o CLAUDE.md + esse EASYPANEL_SETUP.md como contexto
# Peça: "Crie o boilerplate seguindo o CLAUDE.md, mas adaptado para 
# Supabase Cloud + EasyPanel deploy. Use Claude API direto em vez de 
# Lovable AI Gateway."
```

### Passo 2: Inicializar projeto

```bash
# Cria estrutura Vite + React + TypeScript
npm create vite@latest . -- --template react-ts

# Dependencies
npm install @supabase/supabase-js @tanstack/react-query react-router-dom
npm install -D tailwindcss postcss autoprefixer @types/node
npm install lucide-react sonner recharts framer-motion class-variance-authority clsx tailwind-merge zod

# shadcn/ui
npx shadcn-ui@latest init

# Inicializa Supabase local
supabase init
```

### Passo 3: Estrutura de pastas (deixa o Claude Code criar)

```
fce-rosana/
├── src/                    # Frontend React
│   ├── pages/
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   ├── integrations/supabase/
│   └── prompts/
├── supabase/
│   ├── migrations/         # 74+ SQL files
│   ├── functions/          # Edge Functions Deno
│   │   ├── _shared/
│   │   ├── nina-orchestrator/
│   │   └── ...
│   └── config.toml
├── worker/                 # Cron worker Node.js
│   ├── Dockerfile
│   ├── package.json
│   └── cron.js
├── Dockerfile              # Frontend
├── nginx.conf
├── docker-compose.yml      # Pra teste local
├── .env.example
├── CLAUDE.md
└── EASYPANEL_SETUP.md
```

### Passo 4: Variáveis de ambiente

**`.env.example`** (commitado):

```env
# Frontend (build-time, Vite)
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=eyJxxx...
VITE_SUPABASE_PROJECT_ID=xxxxx

# Supabase Functions (Server-side)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJxxx...
SUPABASE_SERVICE_ROLE_KEY=eyJxxx...

# AI Provider
ANTHROPIC_API_KEY=sk-ant-xxx
# OU
# OPENAI_API_KEY=sk-xxx

# Emails
RESEND_API_KEY=re_xxx

# Google Calendar (opcional)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
```

**`.env`** (gitignored, valores reais):

```env
# ... seus valores reais
```

### Passo 5: Docker Compose pra teste local

**`docker-compose.yml`**:

```yaml
version: '3.8'

services:
  app:
    build:
      context: .
      args:
        VITE_SUPABASE_URL: ${VITE_SUPABASE_URL}
        VITE_SUPABASE_PUBLISHABLE_KEY: ${VITE_SUPABASE_PUBLISHABLE_KEY}
        VITE_SUPABASE_PROJECT_ID: ${VITE_SUPABASE_PROJECT_ID}
    ports:
      - "3000:80"
    environment:
      - NODE_ENV=production

  worker:
    build:
      context: ./worker
    environment:
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY}
    restart: unless-stopped
```

Testa local:

```bash
docker-compose up --build
# Abre http://localhost:3000
```

### Passo 6: Push pro GitHub

```bash
git init
git add .
git commit -m "feat: setup inicial FCE"
gh repo create fce-rosana --private --source=. --remote=origin --push
```

### Passo 7: Deploy no EasyPanel

#### 7.1 - Criar projeto no EasyPanel

1. Login no EasyPanel
2. Cria novo project: `fce`
3. **Add service** → **App**

#### 7.2 - Configurar serviço `fce-app`

**Source:**
- Type: **GitHub**
- Repository: `LiaZap/fce-rosana`
- Branch: `main`
- Auto deploy: ✅

**Build:**
- Build pack: **Dockerfile**
- Dockerfile path: `./Dockerfile`
- Build args (vai vir do .env do EasyPanel):
  ```
  VITE_SUPABASE_URL
  VITE_SUPABASE_PUBLISHABLE_KEY
  VITE_SUPABASE_PROJECT_ID
  ```

**Environment:**
- `VITE_SUPABASE_URL=https://xxxxx.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=eyJxxx...`
- `VITE_SUPABASE_PROJECT_ID=xxxxx`

**Ports:**
- `80` (HTTP)

**Domain:**
- `fce.seudominio.com.br` (ou subdomain do EasyPanel: `fce-app.xxxx.easypanel.host`)
- Let's Encrypt: ✅

**Health check:**
- Path: `/`
- Method: GET
- Expected status: 200

#### 7.3 - Configurar serviço `fce-cron-worker`

Mesmo processo, mas:
- Dockerfile path: `./worker/Dockerfile`
- Sem domain (worker interno)
- Sem ports
- Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

#### 7.4 - Trigger primeiro deploy

```bash
git commit -m "trigger deploy" --allow-empty
git push
```

EasyPanel detecta o push e builda. Acompanha logs.

---

## 🔧 PRIMEIRA CONFIGURAÇÃO (após deploy)

### 1. Bootstrap do admin no Supabase

```sql
-- Cria primeira account FCE
INSERT INTO public.accounts (name, slug)
VALUES ('FCE - Filhos com Estilo', 'fce')
ON CONFLICT (slug) DO NOTHING;

-- Após primeiro signup pelo app, vincula como owner
INSERT INTO public.account_members (account_id, user_id, role, status)
SELECT 
  (SELECT id FROM public.accounts WHERE slug = 'fce'),
  auth.users.id,
  'owner'::app_account_role,
  'active'
FROM auth.users
WHERE auth.users.email = 'SEU_EMAIL_AQUI'
ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner';

-- Seed nina_settings com prompt da DANI
INSERT INTO public.nina_settings (
  account_id,
  is_active,
  auto_response_enabled,
  ai_model_mode,
  sdr_name,
  company_name,
  system_prompt_override
)
SELECT 
  id,
  true,
  true,
  'flash',
  'DANI',
  'Filhos com Estilo',
  -- Cole aqui o conteúdo de _shared/dani-prompt.ts
  $DANI$# DANI — Assistente Virtual | Filhos com Estilo & Consultorias Rosana Araujo
...resto do prompt...
$DANI$
FROM public.accounts WHERE slug = 'fce';
```

### 2. Configurar Evolution API webhook

No painel da Evolution API:
- Settings → Webhooks
- URL: `https://xxxxx.supabase.co/functions/v1/whatsapp-webhook`
- Events: ✅ messages.upsert, ✅ messages.update, ✅ connection.update

### 3. Conectar Bling pela UI

- Acesse `https://fce.seudominio.com.br/settings`
- Tab **Bling**
- Cadastre Client ID + Secret do app Bling
- **Redirect URI no Bling**: `https://fce.seudominio.com.br/settings`
- OAuth → autoriza → tokens salvos

### 4. Configurar Cloudinary

- Mesma tab Bling
- Cole cloud_name, api_key, api_secret
- Clica "Enviar imagens pendentes"

### 5. Primeiro sync

- Clica "Sincronizar agora" na tab Bling
- Aguarda 2-5 min
- Confere `produtos_catalogo` no Supabase: deve ter milhares de rows

---

## 🐳 ALTERNATIVA 100% SELF-HOSTED (Supabase no EasyPanel)

Se quiser **tudo** no seu EasyPanel sem depender do Supabase Cloud:

### Stack Supabase Self-Hosted no EasyPanel

EasyPanel tem **template oficial do Supabase**! Procure no marketplace:

1. EasyPanel → New Service → **Templates**
2. Procure por **"Supabase"**
3. Deploy template (cria todos os containers: postgres, gotrue, postgrest, realtime, storage, kong, studio)

**Atenção:**
- Edge Functions self-hosted são complicadas (precisa do **edge-runtime** container)
- Você pode rodar as funções como **API routes Node.js** convencionais em vez de Edge Functions
- Mas isso dá retrabalho — Supabase Cloud free tier é suficiente pros primeiros meses

### Alternativa simples: Backend Node.js convencional

Se quiser sair completamente do paradigma Supabase Functions:

```
fce-rosana/
├── backend/              # NEW: Express/Hono server
│   ├── src/
│   │   ├── routes/
│   │   │   ├── whatsapp-webhook.ts
│   │   │   ├── nina-orchestrator.ts
│   │   │   ├── bling-catalog-sync.ts
│   │   │   └── ...
│   │   ├── lib/
│   │   │   ├── supabase.ts
│   │   │   └── ai-client.ts
│   │   └── index.ts
│   └── Dockerfile
├── frontend/             # Renamed from src/
└── ...
```

**backend/Dockerfile**:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

**backend/src/index.ts** (com Hono — leve e rápido):

```typescript
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import whatsappWebhook from './routes/whatsapp-webhook';
import ninaOrchestrator from './routes/nina-orchestrator';
import productSearch from './routes/product-search';
// ...

const app = new Hono();

app.route('/whatsapp-webhook', whatsappWebhook);
app.route('/nina-orchestrator', ninaOrchestrator);
app.route('/product-search', productSearch);
// ...

serve({ fetch: app.fetch, port: 3001 });
```

A migração dos Edge Functions Deno → Hono Node é fácil porque:
- `Deno.serve` → `serve` do Hono
- `Deno.env.get('X')` → `process.env.X`
- `createClient` do @supabase/supabase-js funciona igual
- Lógica de negócio idêntica

**Vantagem:** roda em qualquer container Docker, não precisa Deno.

---

## 📝 PROMPT INICIAL PRO CLAUDE CODE

Cole isto na primeira mensagem ao iniciar o projeto:

```markdown
Estou recriando o sistema FCE (Filhos com Estilo) com Claude Code + deploy no EasyPanel.

Stack:
- Frontend: React 18 + TypeScript + Vite + Tailwind + shadcn/ui
- Backend: Supabase Cloud (PostgreSQL + Auth + Edge Functions Deno)
- AI: Claude API direto (Anthropic) com prompt caching
- Deploy: EasyPanel via Docker (frontend Nginx + cron worker Node)
- WhatsApp: Evolution API self-hosted (já existe)
- Integrações: Bling ERP v3, Cloudinary, Resend, Google Calendar

Use o CLAUDE.md como blueprint completo do schema, edge functions, prompt da DANI e regras de negócio.

Use o EASYPANEL_SETUP.md para arquitetura adaptada (containers, Dockerfile, cron worker, env vars).

DIRETRIZES IMPORTANTES:
1. Substituir TODAS as referências de Lovable AI Gateway por Claude API (Anthropic)
2. Usar prompt caching para o prompt da DANI (46KB) economizar 90% de custo
3. Frontend deve ser SPA com routing client-side
4. Edge Functions ficam no Supabase Cloud (mais simples)
5. Cron worker Node.js no EasyPanel dispara as functions a cada X segundos/horas
6. Aplicar TODOS os fixes da seção "Bugs conhecidos" do CLAUDE.md
7. Multi-tenant com RLS em TODAS as tabelas
8. Branding FCE: pink #e50789 + green #a3c928

Comece criando:
1. Estrutura básica de pastas
2. package.json com deps
3. Dockerfile + nginx.conf
4. .env.example
5. docker-compose.yml para teste local
6. CLAUDE.md atualizado com decisões desta sessão

Depois vamos criar migrations, edge functions e frontend em sequência.
```

---

## 💰 ESTIMATIVA DE CUSTOS

| Serviço | Plano | Custo/mês |
|---|---|---|
| EasyPanel | Self-hosted (servidor próprio) | $0 (só VPS) |
| VPS (Hetzner/DigitalOcean) | 2 vCPU / 4GB RAM | ~$20 |
| Supabase Cloud | Free | $0 (até crescer) |
| Supabase Cloud | Pro (quando crescer) | $25 |
| Anthropic API (Claude Sonnet 4.5) | ~5k conversas/mês com cache | ~$15-30 |
| Cloudinary | Free tier (25 GB) | $0 |
| Resend | Free tier (3k emails/mês) | $0 |
| Evolution API | Self-hosted no EasyPanel | $0 |
| Domínio + Let's Encrypt | .com.br | ~$3/mês ($40/ano) |
| **TOTAL ESTIMADO** | | **~$40-80/mês** |

vs Lovable Pro: $25/mês + AI usage extra

---

## 🆘 TROUBLESHOOTING ESPECÍFICO

| Problema | Solução |
|---|---|
| Frontend build falha "VITE_X not defined" | Passar build args no Dockerfile ARG/ENV |
| Edge Function não responde | Verificar `supabase functions logs` |
| CORS no frontend | Edge Functions já têm cors headers, mas confere `Access-Control-Allow-Origin: *` |
| Cron worker não dispara | Verificar logs com `docker logs fce-cron-worker` |
| Evolution não chama webhook | Testar manualmente: `curl -X POST URL` |
| Claude API 401 | Verifica ANTHROPIC_API_KEY no Supabase secrets |
| Build EasyPanel lento | Habilita cache do Docker layer no Dockerfile |
| Domínio não resolve | Aponta CNAME pro seu servidor EasyPanel |

---

## 🚀 CHECKLIST DEPLOY FINAL

- [ ] Supabase Cloud projeto criado
- [ ] Todas as migrations aplicadas (`supabase db push`)
- [ ] Todas Edge Functions deployadas (`supabase functions deploy`)
- [ ] Secrets configurados (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`)
- [ ] Repo GitHub criado e código pushed
- [ ] EasyPanel: serviço `fce-app` criado e deployed
- [ ] EasyPanel: serviço `fce-cron-worker` criado e rodando
- [ ] Domain configurado com SSL
- [ ] Primeiro signup feito + bootstrap SQL rodado
- [ ] Prompt DANI carregado no `nina_settings`
- [ ] Evolution webhook atualizado pra novo backend
- [ ] Bling conectado via UI + primeiro sync rodado
- [ ] Cloudinary configurado + upload concluído
- [ ] Teste real end-to-end no WhatsApp da Rosana
- [ ] Monitoramento de logs configurado (Supabase Dashboard)

---

**Última atualização:** 2026-05-27
**Stack:** Claude Code + EasyPanel + Supabase Cloud + Claude API
**Autor:** Paulo (LiaZap) — migração FCE para self-hosted
