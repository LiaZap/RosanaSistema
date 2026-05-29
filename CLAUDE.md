# FCE - Sistema de Atendimento DANI (Filhos com Estilo)

> **Plataforma de atendimento inteligente via WhatsApp** com IA vendedora consultiva (DANI), integração ERP Bling, hospedagem de imagens Cloudinary, e CRM completo.

---

## 🎯 OBJETIVO DO SISTEMA

Substituir o fluxo n8n da loja **Filhos com Estilo & Consultorias Rosana Araujo** (Nova Lima/MG) por um sistema próprio com:

1. **DANI** — Assistente virtual vendedora consultiva no WhatsApp
2. **Sincronização automática** do catálogo Bling → banco local (a cada 5h)
3. **Busca de produtos em tempo real** com fallback SQL
4. **Hospedagem de imagens** Bling → Cloudinary
5. **CRM completo** — pipeline, contatos, conversas, métricas
6. **Multi-tenant** — várias contas com isolamento via RLS

**Cliente:** Rosana Araujo (Filhos com Estilo)
**Pessoa de escalação:** Bia (responsável pelo atendimento humano)
**Loja física:** R. Equador, 27, Jardim das Américas, Nova Lima - MG
**Horários:** Seg-Sex 9-18h, Sáb 9-13h, sem domingo

---

## 🛠️ STACK TÉCNICA

### Frontend
- **React 18** + **TypeScript** + **Vite**
- **Tailwind CSS** + **shadcn/ui** components
- **React Router** (SPA)
- **TanStack Query** (state/cache)
- **Sonner** (toasts)
- **Lucide React** (ícones)
- **Recharts** (gráficos)

### Backend
- **Supabase** (PostgreSQL + Auth + Edge Functions Deno + Storage + Realtime)
- **Lovable Cloud** (hosts o Supabase managed)

### IA
- **Lovable AI Gateway** (`https://ai.gateway.lovable.dev/v1/chat/completions`)
- Modelos: `google/gemini-2.5-flash` (default), `gemini-2.5-pro`, `gemini-3-pro-preview`
- **ElevenLabs** para áudio (opcional)

### Integrações externas
- **Evolution API** (WhatsApp self-hosted) — `https://mythicallamprey-evolution.cloudfy.live`
- **Meta Cloud API** (WhatsApp oficial, alternativa)
- **Bling ERP** v3 (OAuth2) — catálogo, estoque, preços
- **Cloudinary** — hospedagem de imagens de produto
- **Resend** — emails transacionais (opcional)
- **Google Calendar** (opcional, para agendamentos)

### Branding FCE
- **Cores primárias**: Pink `#e50789` (gradient até `#8f1b3f`)
- **Cor secundária**: Verde `#a3c928`
- **Cor de erro**: Vermelho `#f44633`
- **Background**: Dark warm `hsl(340 30% 5%)`
- **Font weights agressivos**, bordas arredondadas `rounded-lg`/`rounded-xl`

---

## 🏗️ ARQUITETURA

```
┌─────────────────────────────────────────────────────────────────┐
│                       CLIENTE (WhatsApp)                         │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓ mensagem
┌─────────────────────────────────────────────────────────────────┐
│            Evolution API (self-hosted) / Meta Cloud API          │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓ webhook POST
┌─────────────────────────────────────────────────────────────────┐
│         Edge Function: whatsapp-webhook                          │
│  - Recebe mensagem, identifica session, cria contact            │
│  - Salva em `messages`, enfileira em `nina_processing_queue`     │
│  - Aciona message-grouper (10s grouping window)                 │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│         Edge Function: message-grouper                           │
│  - Aguarda 10s pra agrupar mensagens em sequência               │
│  - Aciona trigger-nina-orchestrator                              │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│         Edge Function: nina-orchestrator                         │
│  1. claim_nina_processing_batch (lock pessimista)               │
│  2. Carrega settings, conversa, histórico (20 últimas msgs)     │
│  3. Monta prompt DANI + variáveis ({{data_hora}} etc)           │
│  4. Chama Lovable AI Gateway com tools registradas              │
│  5. Processa tool calls (produtos, agendamento, arquivos)       │
│  6. Sanitiza output (strip filler como "Entendi!")              │
│  7. Enfileira em send_queue                                      │
│  8. Aciona whatsapp-sender                                       │
└─────────────────────────┬───────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│         Edge Function: whatsapp-sender                           │
│  - Lê send_queue, envia via Evolution/Meta API                  │
│  - Atualiza status (sent/delivered/read)                         │
└─────────────────────────────────────────────────────────────────┘

PARALELAMENTE:
┌─────────────────────────────────────────────────────────────────┐
│  CRON 5h: bling-catalog-sync                                    │
│  - Pagina Bling → produtos_catalogo (até 5000 itens)            │
│  - Auto-refresh OAuth2 token                                     │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│  MANUAL: bling-cloudinary-upload                                │
│  - Lê produtos com imagem_bling, envia pro Cloudinary           │
│  - SHA-1 signed upload, public_id = bling_<id>                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🗄️ SCHEMA DO BANCO

### Tabelas principais (~80 tabelas no total, principais abaixo)

**Multi-tenant + Auth:**
- `accounts` — empresas/contas (slug, name, plan)
- `account_members` — vínculo user→account (role: owner/admin/manager/sdr)
- `profiles` — perfis dos usuários
- `user_roles` — roles legados (admin/user)

**Conversação:**
- `contacts` — clientes (telefone, nome, tags, client_memory JSONB)
- `conversations` — sessão de chat (status: nina/human/paused)
- `messages` — mensagens (from_type: user/nina/human, type: text/image/audio/document, media_url, processed_by_nina)
- `conversation_states` — estado da máquina de estados (pra rate limit, anti-loop)

**IA & Filas:**
- `nina_settings` — configuração da DANI por account (system_prompt_override, ai_model_mode, response_delay_min/max, message_breaking_enabled, audio_response_enabled, elevenlabs_*, evolution_*, whatsapp_*)
- `nina_processing_queue` — fila de processamento da DANI (status: pending/processing/completed/failed)
- `send_queue` — fila de envio pra WhatsApp (priority, scheduled_at, message_type, media_url)

**WhatsApp:**
- `whatsapp_sessions` — instâncias (provider: evolution/meta, status: connected/disconnected)
- `whatsapp_account_settings` — config Evolution por account (api_url, api_key)
- `whatsapp_queues` — filas de atendimento humano

**CRM:**
- `pipeline_stages` — colunas do Kanban (Novos Leads, Em Qualificação, Oportunidade, Fechamento, Ganho, Perdido)
- `deals` — oportunidades (contact_id, stage_id, value, expected_close_date)
- `tag_definitions` — tags pré-cadastradas
- `appointments` — agendamentos (date, time, duration, type, google_event_id, meeting_url)
- `google_calendar_connections` — OAuth Google por user/account
- `media_library` — biblioteca de PDFs/imagens da DANI enviar

**Produtos (n8n migrado):**
- `produtos_catalogo` — espelho do Bling (bling_id, nome, nome_normalizado, codigo, preco, preco_promocional, estoque, disponivel, descricao_curta, imagem_bling, imagem_cloudinary, cloudinary_uploaded_at, marca, categoria, situacao)
- `bling_credentials` — OAuth Bling (client_id, client_secret, refresh_token, access_token, expires_at)
- `cloudinary_credentials` — credenciais (cloud_name, api_key, api_secret, upload_tag, last_sync_at)

**Email & Templates:**
- `email_templates` — templates Resend
- `email_logs` — auditoria

**Equipe:**
- `teams` — Vendas, Suporte
- `team_functions` — SDR, Closer, CS
- `team_members` — vínculo profile→team

**Coworking (opcional):**
- `coworking_*` — sistema modular de gestão de coworking

### Funções SQL importantes

```sql
-- Busca produtos com scoring PT-BR (exato=100, prefix=50, contains=30, +40 se disponível)
buscar_produtos(p_consulta TEXT, p_limit INT DEFAULT 15)

-- Claim batch atômico pra evitar processar 2x
claim_nina_processing_batch(p_limit INT)

-- Trigger handle_new_user — cria profile + account_member ao signup
-- Primeiro signup vira admin automaticamente

-- RPC truncate_produtos_catalogo() — usado pelo sync
```

### Extensões necessárias

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- busca fuzzy
CREATE EXTENSION IF NOT EXISTS unaccent;     -- remoção de acentos
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid
```

### RLS Policies (resumo)

Todas as tabelas têm RLS habilitado. Padrão geral:
- **SELECT**: `is_account_member(account_id) OR is_super_admin()`
- **INSERT/UPDATE/DELETE**: `has_account_role(account_id, ['owner','admin']) OR is_super_admin()`
- **Service Role**: sempre passa (Edge Functions usam service_role_key)

Helpers SQL:
- `is_account_member(account_id UUID) RETURNS BOOLEAN`
- `has_account_role(account_id UUID, roles app_account_role[]) RETURNS BOOLEAN`
- `is_super_admin() RETURNS BOOLEAN`

---

## ⚡ EDGE FUNCTIONS (Deno + TypeScript)

Todas em `supabase/functions/`. Cada uma com `index.ts` e shared deps em `_shared/`.

### Fluxo principal (WhatsApp)

| Função | Responsabilidade |
|---|---|
| `whatsapp-webhook` | Recebe POST do Evolution/Meta, salva mensagem, enfileira |
| `message-grouper` | Aguarda 10s para agrupar mensagens em sequência |
| `trigger-nina-orchestrator` | Wrapper pra acionar orchestrator via cron/pg_net |
| `nina-orchestrator` | **Core da DANI**: chama IA, processa tools, enfileira resposta |
| `whatsapp-sender` | Lê send_queue, envia via Evolution/Meta API |
| `whatsapp-session-create` | Cria instância Evolution (`fce-{accountId}` prefix) |
| `whatsapp-session-connect` | Conecta sessão, gera QR code |
| `analyze-conversation` | Análise pós-conversa (sentiment, qualificação) |

### Produtos (migrações n8n)

| Função | Responsabilidade |
|---|---|
| `bling-catalog-sync` | Sync paginado Bling → produtos_catalogo (a cada 5h) |
| `bling-auth` | OAuth2 Bling (save_credentials, authorize, callback, status, disconnect) |
| `product-search` | Busca com scoring SQL + estoque em tempo real Bling (fallback cache 3s timeout) |
| `cloudinary-auth` | Validação credenciais Cloudinary via ping |
| `bling-cloudinary-upload` | Upload em batch Bling → Cloudinary com SHA-1 signed upload |

### Sistema

| Função | Responsabilidade |
|---|---|
| `initialize-system` | Seed inicial (pipeline_stages, tag_definitions, teams, nina_settings) |
| `health-check` | Diagnóstico de componentes |
| `account-invite` | Convida membros |
| `super-admin-create-client` | Cria nova conta (super admin) |
| `send-transactional-email` | Envia email via Resend |
| `send-invite-email` | Envio específico de convite |
| `transactional-email-templates/` | React Email templates compilados |
| `google-calendar-auth` | OAuth Google Calendar |

### Shared (`_shared/`)

```typescript
// dani-prompt.ts — Prompt completo da DANI (~46KB)
export const DANI_SYSTEM_PROMPT = `# DANI — Assistente Virtual...`;

// bling-token.ts — Token refresh + stock batch
export async function getValidBlingToken(supabase, accountId): Promise<string | null>;
export async function fetchBlingStockBatch(token, blingIds, timeoutMs): Promise<Record>;

// transactional-email-templates/ — Templates Resend
```

---

## 🤖 TOOLS DO ORCHESTRATOR (Function Calling)

Registradas no body da chamada AI:

| Tool | Quando usar | Parâmetros |
|---|---|---|
| `buscar_produtos` | Cliente pede lista/preço/categoria | `consulta` (nome base do produto) |
| `buscar_produto_detalhe` | Cliente pede foto de produto específico | `consulta` |
| `create_appointment` | Cliente confirma agendamento | `title, date, time, duration, type, description` |
| `reschedule_appointment` | Cliente quer remarcar | `new_date, new_time, reason` |
| `cancel_appointment` | Cliente quer cancelar | `reason` |
| `send_file` | Cliente pede catálogo/PDF da biblioteca | `search_query, reason` |

### Pós-processamento crítico no orchestrator

```typescript
// 1. ANTES de processar tool: descartar filler placeholder se há tool call
if (hasProductSearchCall && isGenericPlaceholder(aiContent)) {
  aiContent = '';
}

// 2. Tool handlers SOBRESCREVEM aiContent com resposta formatada
// Exemplo product card:
aiContent = `${p.imagem}\n\nAqui está o *${p.nome}*. Está por *R$ ${p.preco}*.\n\nQuer que eu separe para você?`;

// 3. DEPOIS de tudo: paranoid mode (strip filler prefix mesmo sem tool call)
const fillerPrefixes = [
  /^entendi[!.,\s]*(como posso ajudar)?/i,
  /^(um|só um) momento/i,
  /^(vou|deixa eu)\s+(verificar|buscar|pesquisar)/i,
  /^aguarde/i,
  // ...
];

// 4. Se mensagem inteira é só filler, SUPRIMIR (não enviar nada)
if (strippedFiller && aiContent.length < 5) {
  return; // não envia
}
```

**LIÇÃO APRENDIDA:** O Lovable AI Gateway frequentemente gera filler como "Entendi! Como posso ajudar?" junto com tool calls. Precisa de **defesa em profundidade**: prompt + isGenericPlaceholder + paranoid mode + (se persistir) trigger SQL no `send_queue`.

---

## 👤 ESPECIFICAÇÃO DA DANI

**Identidade:** vendedora consultiva da Filhos com Estilo e Consultorias Rosana Araujo. NUNCA admite ser bot.

**Tom:** Direto, caloroso, comercial. PT-BR brasileiro. Sem hífens. Negrito com `*um asterisco*`.

**Regra de ouro:** NUNCA aceita primeiro "não" — aplica uma das 6 técnicas de quebra de rejeição:
1. Pergunta de investigação
2. Oferta de alternativa
3. Quebra de preço (parcelamento 3x)
4. Urgência suave (reserva 24h)
5. Prova social
6. Fechamento alternativo

**Tools obrigatórias:**
- Cliente pede preço/lista → `buscar_produtos`
- Cliente pede foto → `buscar_produto_detalhe`
- NUNCA pergunta tamanho/cor/marca ANTES de buscar

**Lei da Ferramenta:**
- `status = ENCONTRADO` + `disponivel = true` → apresenta
- `status = SEM_ESTOQUE` → busca alternativa similar
- `status = NAO_ENCONTRADO` → tenta sinônimos antes de desistir

**Tabela de aluguel (FIXA, não buscar no Bling):**
17 produtos com 3 períodos (7d, 15d, 30d). Carrinho Ping Two, Cadeirão, Berço, Moisés, Jumperoo, Cadeira Bumbo, Bicicleta Clingo, Andador, Bomba Medela, Banheira Clingo, etc.

**5 Consultorias de Enxoval:**
1. **Smart Baby** — R$ 147 (questionário + PDF em 3 dias)
2. **Estilosa** — R$ 475 (reunião 2h30, 60% reverte em compras)
3. **VIP** — 2 reuniões, indicação carrinho/bebê conforto
4. **Concierge Travel Baby** — importados
5. **Premium** — tudo + acompanhamento até nascimento

**Escalação:** SEMPRE para a **Bia** (nunca menciona Rosana). Mensagem padrão:
> "Ótimo! Vou transferir seu atendimento para a *Bia*, nossa responsável. Pode ser que ela esteja em atendimento agora, mas fique tranquila, dentro do horário comercial ela vai te retornar."

**Silêncio total após:**
- Despedida do cliente ("tchau", "obrigada")
- Escalação para Bia (até 4h de inatividade)
- Humano entrar na conversa

**Comprovante Pix/transferência:** silêncio absoluto.

**Conhecimento específico:**
- **Windi** — eliminador de gases. Higienizável (sabão neutro + álcool), individual, 2-3 unidades por casa. NUNCA "descartável".
- **Colic Calm Importado EUA** — suplemento para cólicas, R$ 309,90
- **Resfriado/gripe** — 6 produtos: Pomada Soothing Chest Rub Zarbees, Baby Room Mist, Balsamo Reconfortante Verdi, Sal de Banho Magnésio, Vapor Bubble Bath Babyganics, Sabonete Espuma de Vapor

**Prompt completo:** `supabase/functions/_shared/dani-prompt.ts` (~46KB, 1133 linhas).
Mirror frontend: `src/prompts/default-nina-prompt.ts`.

**IMPORTANTE:** Prompt usa TEXTO DIRETO (não JSON output). Tools: `buscar_produtos`, `buscar_produto_detalhe`. Campo de imagem: `imagem` (não `url_imagem`).

---

## 🎨 UI / TELAS PRINCIPAIS

### Layout
- Sidebar lateral colapsável (DesktopSidebar 76px-260px, MobileSidebar full-screen)
- Header com avatar do user, notificações
- Dark theme com glassmorphism (slate-900/50 backdrop-blur)

### Páginas (`src/pages/`)
- `/auth` — Login + Signup (com botão direto pra criar primeira conta)
- `/dashboard` — Métricas, gráficos
- `/contacts` — Lista de contatos
- `/conversations` — Chat interface
- `/kanban` — Pipeline de vendas
- `/team` — Gestão de equipe
- `/scheduling` — Agendamentos + Google Calendar
- `/settings` — Configurações com tabs
- `/reports` — Relatórios (AI Performance, KPIs, etc)
- `/admin/*` — Super admin (multi-tenant)
- `/invite/:token` — Aceite de convite

### Settings tabs (`src/components/Settings.tsx`)
1. **Agente** — prompt, modelo IA, delays, voz
2. **APIs** — Lovable AI key, ElevenLabs, etc
3. **WhatsApp** — Sessions Evolution/Meta
4. **Filas** — WhatsApp queues
5. **Documentação** — System Roadmap
6. **Arquivos** — Media Library (PDFs/imagens DANI)
7. **Conta** — perfil + plano
8. **Email** — Resend config
9. **Bling** ⭐ — Tab nova: integração Bling + Cloudinary com OAuth UI
10. **Coworking** — opcional

### Onboarding (7 passos)
1. Boas-vindas
2. WhatsApp (Evolution/Meta)
3. Identidade (nome empresa, nome SDR=DANI)
4. Prompt da DANI
5. Horários comerciais
6. Pipeline padrão
7. Teste com mensagem real

---

## 🔌 INTEGRAÇÕES (Setup)

### 1. Bling ERP (OAuth2)

**Setup pela UI** (`Settings → Bling`):
1. Cliente cria app em https://developer.bling.com.br/aplicativos
2. Configura Redirect URI: `https://{lovable-app}.lovable.app/settings`
3. Cola Client ID + Client Secret na UI
4. Clica "Conectar com Bling" → OAuth flow
5. Tokens salvos em `bling_credentials`

**Endpoints Bling usados:**
- `POST /Api/v3/oauth/token` — refresh (Basic Auth)
- `GET /Api/v3/produtos?pagina=N&limite=100` — paginado
- `GET /Api/v3/estoques/saldos?idsProdutos[]=X` — estoque batch

### 2. Cloudinary

**Setup pela UI** (`Settings → Bling → Cloudinary`):
1. Pega cloud_name, api_key, api_secret em https://console.cloudinary.com
2. Cola na UI (validação via `/v1_1/{cloud}/ping`)
3. Clica "Enviar imagens pendentes" pra fazer upload Bling → Cloudinary
4. Public ID convention: `bling_<bling_id>`
5. URL transformation: `w_800,c_limit,f_jpg,q_85`
6. Tag default: `loja_filhos_com_estilo`

### 3. Evolution API (WhatsApp)

**Já existe em produção:** `https://mythicallamprey-evolution.cloudfy.live`
- Instance name: `agentedani`
- Webhook URL: `{supabase}/functions/v1/whatsapp-webhook`
- Events: `messages.upsert`, `messages.update`, `connection.update`

### 4. Lovable AI Gateway

**Secret:** `LOVABLE_API_KEY`
- URL: `https://ai.gateway.lovable.dev/v1/chat/completions`
- Modelos suportados: Gemini 2.5 Flash/Pro, Gemini 3 Pro Preview
- Suporta function calling + multimodal (image_url)

### 5. ElevenLabs (opcional)

- API: `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`
- Voice default Brasil: `33B4UnXyTNbgLmdEDh5P` (Keren)
- Model: `eleven_turbo_v2_5`
- Só responde com áudio se mensagem ENTRANTE foi áudio (mirroring)

---

## 🚀 SETUP DO ZERO NO LOVABLE

### Passo 1: Criar projeto Lovable

```
Prompt inicial:
"Crie um CRM completo de atendimento WhatsApp com IA chamada DANI.
Stack: React + TypeScript + Vite + Tailwind + Supabase.
Multi-tenant com RLS. Pipeline Kanban. Integrações Bling ERP + Cloudinary
+ Evolution API + Resend + Google Calendar.
Use as cores pink #e50789 e green #a3c928."
```

### Passo 2: Migrations (74+ no total)

Aplicar **em ordem cronológica**. Categorias:

1. **Auth + Multi-tenant** — accounts, account_members, profiles, user_roles, RLS helpers
2. **Conversação** — contacts, conversations, messages, conversation_states
3. **IA & Filas** — nina_settings, nina_processing_queue, send_queue
4. **WhatsApp** — whatsapp_sessions, whatsapp_account_settings, whatsapp_queues
5. **CRM** — pipeline_stages, deals, tag_definitions, appointments
6. **Email** — email_templates, email_logs
7. **Equipe** — teams, team_functions, team_members
8. **Mídia** — media_library
9. **Produtos** — produtos_catalogo + função buscar_produtos
10. **Bling** — bling_credentials
11. **Cloudinary** — cloudinary_credentials
12. **Triggers** — handle_new_user, update_updated_at_column

### Passo 3: Edge Functions

Criar todas na pasta `supabase/functions/`. Cada uma com `index.ts`.

**Ordem de prioridade:**
1. `whatsapp-webhook` + `whatsapp-sender` (loop básico)
2. `nina-orchestrator` (core IA)
3. `bling-catalog-sync` + `product-search` (catálogo)
4. `bling-auth` + `cloudinary-auth` + `bling-cloudinary-upload` (OAuth)
5. `initialize-system` (seed inicial)
6. `message-grouper` + `analyze-conversation` (otimizações)
7. `account-invite` + `send-transactional-email` (convites)
8. `google-calendar-auth` (agendamentos)

### Passo 4: Secrets

Configurar em **Project Settings → Secrets**:
- `LOVABLE_API_KEY` — gateway IA
- `RESEND_API_KEY` — emails (opcional)
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` — agendamentos (opcional)

Evolution API e Bling/Cloudinary são configuradas via UI (não secrets).

### Passo 5: Frontend

Estrutura `src/`:
```
src/
├── pages/         # Routes principais
├── components/
│   ├── ui/        # shadcn components
│   ├── settings/  # Tabs do Settings
│   ├── landing/   # Landing page pública
│   ├── account/   # Account management
│   ├── onboarding/ # Wizard 7 passos
│   ├── reports/   # Gráficos
│   ├── admin/     # Super admin
│   ├── Button.tsx # Custom (gradient pink)
│   └── ...
├── hooks/         # Custom hooks
│   ├── useAuth.tsx
│   ├── useActiveAccount.tsx
│   ├── useConversations.ts
│   ├── useBlingIntegration.ts
│   ├── useCloudinaryIntegration.ts
│   └── useGoogleCalendar.ts
├── integrations/
│   └── supabase/
│       ├── client.ts
│       └── types.ts  # Auto-gerado
├── lib/           # Utils (cn, activeAccount, permissions)
├── prompts/
│   └── default-nina-prompt.ts  # Mirror do _shared
└── App.tsx
```

### Passo 6: Primeiro bootstrap

```sql
-- 1. Primeiro user via signup vira admin automaticamente (trigger handle_new_user)
-- 2. Mas precisa criar account + account_members manualmente:

INSERT INTO public.accounts (name, slug)
VALUES ('FCE - Filhos com Estilo', 'fce')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.account_members (account_id, user_id, role, status)
SELECT 
  (SELECT id FROM public.accounts WHERE slug = 'fce'),
  auth.users.id,
  'owner'::app_account_role,
  'active'
FROM auth.users
WHERE auth.users.email = 'EMAIL_DO_ADMIN_AQUI'
ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner';
```

### Passo 7: Configurar pela UI (na ordem)

1. **Login** → Onboarding 7 passos
2. **Settings → Agente** — colar prompt DANI completo
3. **Settings → WhatsApp** — conectar Evolution (Server URL + API Key + Instance Name `agentedani`)
4. **Settings → Bling** — credenciais + OAuth + primeira sincronização
5. **Settings → Bling (Cloudinary)** — credenciais + upload imagens
6. **Settings → Email** — Resend (opcional)
7. **Teste** — manda mensagem real no WhatsApp da loja

---

## ⚠️ BUGS CONHECIDOS & FIXES APLICADOS

### Bug 1: "Entendi! Como posso ajudar?" vaza pro cliente

**Causa:** Lovable AI Gateway gera filler junto com tool calls.

**Fix em 4 camadas (defesa em profundidade):**

1. **Prompt** — adicionar regras críticas no topo do `system_prompt_override`:
   ```
   ## ⚠️ REGRAS CRÍTICAS ABSOLUTAS
   PROIBIDO: "Entendi! Como posso ajudar?", "Um momento", "Vou verificar"
   QUANDO CHAMAR TOOL: NÃO escreva nada antes
   APÓS FOTO: SEMPRE termine com "Quer que eu separe para você?"
   ```

2. **Helper `isGenericPlaceholder()`** no orchestrator — descarta aiContent placeholder ANTES de processar tool:
   ```typescript
   const placeholders = [
     /^entendi[!.\s]*como posso ajudar/i,
     /^entendi[!.\s]*$/i,
     /^um momento/i,
     /^vou verificar/i,
     // ...
   ];
   ```

3. **Paranoid mode** no FINAL — strip prefix filler do aiContent, mesmo sem tool call. Se mensagem inteira é só filler, SUPRIMIR (não enviar nada).

4. **Trigger SQL last-resort** em `send_queue` BEFORE INSERT:
   ```sql
   CREATE TRIGGER trg_sanitize_dani_send_queue
     BEFORE INSERT ON send_queue
     FOR EACH ROW
     EXECUTE FUNCTION sanitize_dani_outgoing();
   ```

### Bug 2: Product card sem "Quer que eu separe?"

**Causa:** formato do card no orchestrator não incluía pergunta.

**Fix:** novo formato seguindo template do prompt:
```typescript
aiContent = `${p.imagem}\n\nAqui está o *${p.nome}*. Está por *R$ ${p.preco}*.\n\nQuer que eu separe para você?`;
```

### Bug 3: Bootstrap impossível — sem admin no primeiro signup

**Causa:** trigger `handle_new_user` tenta vincular ao account `axholding` (legado) que não existe em projeto novo.

**Fix:** rodar SQL manual após primeiro signup (passo 6 acima).

### Bug 4: Edge Function cache antigo após deploy

**Causa:** Deno deploy serve versões cached.

**Fix:** force redeploy via Lovable AI chat: "redeploy nina-orchestrator". OU usar trigger SQL (que é instantâneo).

### Bug 5: Imagem de produto em baixa qualidade

**Causa:** orchestrator estava pegando miniatura do Bling.

**Fix:** pegar imagem full do Bling, salvar em storage, servir do storage. **OU** usar Cloudinary com transformação `w_800,c_limit,f_jpg,q_85`.

### Bug 6: Conexão GitHub - "Repository not found"

**Causa:** repo Lovable é privado, conta GitHub local não tem acesso.

**Fix:**
- Verificar nome exato do repo (Lovable adiciona hash sufixo tipo `whatsapp-crm-starter-a9db208e`)
- Adicionar SSH key na conta GitHub correta
- Configurar collaborator se necessário

---

## 📊 MÉTRICAS & MONITORAMENTO

### Logs estruturados (Edge Functions)

Padrão `[Nina]`, `[Webhook:Evolution]`, `[BlingSync]`, `[CloudUpload]`, `[ProductSearch]`.

Logs críticos para debug:
- `[Nina] AI response received, content length: X, tool_calls: Y`
- `[Nina] Discarding generic placeholder content`
- `[Nina] Processing buscar_produto_detalhe tool call:`
- `[Nina] Stripped filler prefix (was X chars, now Y)`
- `[Nina] Final response length: X`

### Métricas no Reports

- **AI Performance** — taxa de resolução autônoma (DANI vs humano)
- **KPI Cards** — atendimentos hoje, tempo médio resposta, conversões
- **Volume de mensagens por dia** — AreaChart
- **Tipos de mensagem** — PieChart
- **Status conversas** — bar progress (nina/humano/pausadas)

---

## 🔐 SEGURANÇA

- **RLS** em TODAS as tabelas (sem exceção)
- **Service role** só usado em Edge Functions
- **Secrets** em Project Settings (nunca em code)
- **OAuth** com state CSRF + nonce
- **API keys Bling/Cloudinary** armazenadas em banco (não secrets) — protegidas por RLS
- **Verify token WhatsApp** com prefix `fce-` aleatório
- **Senhas** validadas contra HaveIBeenPwned (config padrão Supabase)
- **Account isolation** — `is_account_member()` checa membership ativo

---

## 🎯 FEATURES FUTURAS / ROADMAP

- [ ] Auto-aprovação de signups (configurável por account)
- [ ] Webhook bidirecional Bling → catálogo (sem precisar polling de 5h)
- [ ] Cloudinary upload automático após sync Bling
- [ ] Cron pg_cron pra disparar sync sem depender de scheduler externo
- [ ] Suporte a múltiplas lojas por account
- [ ] Dashboard de vendas (deals fechados, ticket médio)
- [ ] Integração WooCommerce/Shopify (alternativas ao Bling)
- [ ] DANI multimodal (analisar foto enviada pelo cliente)
- [ ] Memória persistente da DANI por contato (já tem `client_memory` JSONB)
- [ ] Auto-tag de leads via análise de conversa
- [ ] Notificações push para operadores humanos
- [ ] Mobile app React Native

---

## 🆘 TROUBLESHOOTING RÁPIDO

| Sintoma | Diagnóstico | Fix |
|---|---|---|
| Onboarding "violates RLS policy" | account_members vazio | SQL bootstrap (passo 6) |
| Tabela `nina_settings` not found | Migrations não aplicadas | Pede Lovable AI: "apply all migrations from supabase/migrations" |
| DANI manda "Entendi! Como posso ajudar?" | Filler do AI Gateway vazando | Trigger SQL `sanitize_dani_outgoing` |
| Produto sem foto | Cloudinary não configurado | Settings → Bling → cadastra Cloudinary + upload |
| Token Bling expirado | Refresh falhou | Settings → Bling → Reconectar |
| "Repository not found" no git push | Repo privado sem acesso | Adicionar SSH key na conta dona do repo |
| Build "TypeScript types out of sync" | types.ts regenerado vazio | Re-rodar migrations |
| Stock desatualizado | Sync 5h não rodou | Settings → Bling → "Sincronizar agora" |

---

## 📚 REFERÊNCIAS

- **Bling API v3**: https://developer.bling.com.br
- **Cloudinary API**: https://cloudinary.com/documentation
- **Evolution API**: https://doc.evolution-api.com
- **Lovable Docs**: https://docs.lovable.dev
- **Supabase Edge Functions**: https://supabase.com/docs/guides/functions
- **Lovable AI Gateway**: usar como OpenAI-compatible
- **shadcn/ui**: https://ui.shadcn.com

---

## ✅ CHECKLIST DE GO-LIVE

- [ ] Migrations aplicadas (74+)
- [ ] Edge Functions deployadas (15+)
- [ ] Secret `LOVABLE_API_KEY` configurada
- [ ] Primeiro admin criado + bootstrap SQL rodado
- [ ] Prompt DANI carregado em `nina_settings.system_prompt_override`
- [ ] Triggers SQL `sanitize_dani_outgoing` ativos
- [ ] Evolution API conectada (instance `agentedani`)
- [ ] Webhook Evolution apontando pra `whatsapp-webhook`
- [ ] Bling OAuth conectado + primeiro sync rodado
- [ ] Cloudinary configurado + upload imagens completo
- [ ] Logo FCE substituído (`src/assets/icon-iris.png`)
- [ ] WhatsApp real da Rosana em `whatsappLink.ts`
- [ ] Domínio FCE configurado (não usar `fce.com.br` placeholder)
- [ ] Cron pg_cron agendado pra `bling-catalog-sync` a cada 5h
- [ ] Teste real end-to-end com mensagem WhatsApp

---

**Última atualização:** 2026-05-27
**Versão:** v16.16 (DANI prompt) + arquitetura migrada do n8n
**Autor:** Paulo (LiaZap) — adaptação do projeto iris-axholding para Rosana FCE
