# FCE — Filhos com Estilo

Sistema de atendimento WhatsApp com IA vendedora consultiva (DANI), CRM e integrações Bling/Cloudinary.

> **Status atual:** Fase 1 — Setup mínimo deployável (login/signup + healthcheck).
> Próximas fases adicionam DANI orchestrator, integração Bling, Webhook WhatsApp e upload Cloudinary.

---

## Stack

- **Frontend** — React 18 + Vite + Tailwind CSS
- **Backend** — Hono + Drizzle ORM + Lucia v3 Auth + node-postgres
- **Worker** — BullMQ (placeholder em Fase 1)
- **Banco** — PostgreSQL 16 (pg_trgm, unaccent, pgcrypto)
- **Storage** — MinIO (S3-compatible)
- **Cache/Fila** — Redis 7

## O que funciona em Fase 1

- Login / Signup com cookie de sessão (`fce_session`, httpOnly, sameSite=lax)
- Bootstrap: primeiro usuário vira automaticamente `owner` da conta FCE
- Endpoint `GET /health` checando Postgres, Redis e MinIO
- Frontend `/auth` e `/dashboard` com branding FCE (pink #e50789, green #a3c928)
- Worker placeholder conectando ao Redis (sem jobs ainda)

## Quick Start (Local)

```bash
cp .env.example .env
# edite .env com suas credenciais

# Sobe infraestrutura (postgres, redis, minio)
docker compose up -d

# Em janelas separadas:
cd backend && npm install && npm run db:migrate && npm run dev
cd worker  && npm install && npm run dev
cd frontend && npm install && npm run dev
```

| Serviço   | URL                          |
|-----------|------------------------------|
| Frontend  | http://localhost:3000        |
| API       | http://localhost:3001        |
| MinIO UI  | http://localhost:9001        |
| Postgres  | localhost:5432               |
| Redis     | localhost:6379               |

## Deploy EasyPanel

Veja [`EASYPANEL_SETUP.md`](./EASYPANEL_SETUP.md) e [`docs/RUNBOOK-DEPLOY.md`](./docs/RUNBOOK-DEPLOY.md).

Pré-requisitos:
- Serviços `postgres-fce`, `redis-fce`, `minio-fce` já rodando no EasyPanel
- Variáveis de ambiente configuradas (use `.env.production.example` como base)

```bash
# Produção
docker compose -f docker-compose.prod.yml up -d --build
```

## Estrutura

```
frontend/   React + Vite + Tailwind
backend/    Hono + Drizzle + Lucia
worker/     BullMQ jobs (placeholder)
postgres/   Dockerfile + init.sql (extensões)
docs/       Runbooks e documentação
scripts/    Utilitários (gerador de secrets)
```

## Build & Test

```bash
# Backend
cd backend && npm run build

# Worker
cd worker && npm run build

# Frontend
cd frontend && npm run build
```

## Próximas Fases

- **Fase 2** — DANI orchestrator com Claude API + tools (`buscar_produtos`, `buscar_produto_detalhe`)
- **Fase 3** — Integração Bling ERP (OAuth2 + sync 5h)
- **Fase 4** — Webhook WhatsApp via Evolution API
- **Fase 5** — Upload Cloudinary para imagens de produtos
- **Fase 6** — CRM completo (Kanban, contatos, conversas)
