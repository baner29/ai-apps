# Multi-stage Dockerfile for Google Cloud Run deployment
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build frontend assets
COPY . .
RUN npm run build

# Production runtime stage
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV GOOGLE_GENAI_USE_VERTEXAI=True
ENV OOGLE_GENAI_USE_VERTEXAI=True
ENV GOOGLE_CLOUD_LOCATION=global
ENV GEMINI_MODEL=gemini-3.8-flash

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/src/data/indian_wedding_hashtags_template.json ./src/data/indian_wedding_hashtags_template.json

EXPOSE 8080

CMD ["node", "server.js"]
