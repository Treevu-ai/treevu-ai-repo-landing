FROM node:20-slim

RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar lockfile primero → npm ci no re-resuelve URLs de GitHub
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js .

# La carpeta auth/ se monta como volumen persistente en Fly.io
RUN mkdir -p auth

EXPOSE 3001

CMD ["node", "server.js"]
