#!/usr/bin/env bash
# ============================================================
# FCE - Production Secrets Generator
# ============================================================
# Generates strong random passwords and outputs a ready-to-use
# .env block. Run once during initial server setup.
#
# Usage:
#   chmod +x scripts/generate-secrets.sh
#   ./scripts/generate-secrets.sh
#   # Or pipe directly into .env:
#   ./scripts/generate-secrets.sh >> .env
# ============================================================

set -euo pipefail

PG_PASS=$(openssl rand -base64 32 | tr -d '=/+' | head -c 40)
MINIO_PASS=$(openssl rand -base64 32 | tr -d '=/+' | head -c 40)

cat <<EOF
# ── Generated secrets ($(date -u +"%Y-%m-%dT%H:%M:%SZ")) ──

POSTGRES_PASSWORD=${PG_PASS}
DATABASE_URL=postgresql://fce:${PG_PASS}@postgres:5432/fce
MINIO_ROOT_PASSWORD=${MINIO_PASS}

# Paste your Anthropic API key manually:
# ANTHROPIC_API_KEY=sk-ant-...
EOF

echo ""
echo "# ── Summary ──"
echo "#   Postgres password : ${PG_PASS}"
echo "#   MinIO password    : ${MINIO_PASS}"
echo "#"
echo "# IMPORTANT: Also set ANTHROPIC_API_KEY manually in .env"
echo "# IMPORTANT: Replace DOMAIN placeholder in .env with your real domain"
