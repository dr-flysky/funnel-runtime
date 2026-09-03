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
EXPOSE 3000

# Deliberately no `VOLUME /data`. It declares an anonymous volume at image
# level, which Railway does not support and which can shadow the persistent
# volume a platform mounts at the same path. Every target attaches storage in
# its own config instead — [[mounts]] on Fly, disk.mountPath on Render, the
# service volume on Railway, `-v` for a local `docker run`. When nothing is
# mounted, openDb() just creates /data as an ordinary directory.

# Seed on first boot so a fresh deployment has a published funnel.
CMD sh -c "npx tsx scripts/seed-if-empty.ts && npm start"
