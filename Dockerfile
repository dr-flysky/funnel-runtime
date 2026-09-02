# Node 22.5+ is required for the built-in node:sqlite module.
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_FILE=/data/funnel.db
VOLUME /data
EXPOSE 3000

# Seed on first boot so a fresh deployment has a published funnel.
CMD sh -c "npx tsx scripts/seed-if-empty.ts && npm start"
