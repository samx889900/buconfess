FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies only
FROM base AS deps
RUN apk add --no-cache libc6-compat openssl
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev
RUN npx prisma generate

# Build stage
FROM base AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci
RUN npx prisma generate
COPY . .
RUN npm run build

# Runner stage
FROM base AS runner
WORKDIR /app
RUN apk add --no-cache openssl fontconfig ttf-dejavu && fc-cache -f
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps /app/node_modules/bcryptjs ./node_modules/bcryptjs
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma
COPY --from=deps /app/node_modules/.bin ./node_modules/.bin
COPY --from=builder /app/seed.js ./seed.js

RUN mkdir -p /data && chown nextjs:nodejs /data
USER nextjs

EXPOSE 8080

COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
CMD ["sh", "/app/entrypoint.sh"]
