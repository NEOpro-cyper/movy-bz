# Coolify / VPS Dockerfile
# Minimal Node.js image, no build step needed
FROM node:18-alpine

WORKDIR /app

# Install deps (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY server.js index.js routes.js ./
COPY api ./api

# Coolify sets PORT env automatically; default to 3000
ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
