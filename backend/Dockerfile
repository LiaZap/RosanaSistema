FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# Migration files (SQL + drizzle meta/_journal.json) required by node dist/db/migrate.js
COPY --from=builder /app/drizzle ./drizzle
# Optional: custom SQL functions used by Phase 2+ (buscar_produtos etc)
COPY --from=builder /app/src/db/functions.sql ./src/db/functions.sql
EXPOSE 3001
CMD ["node", "dist/index.js"]
