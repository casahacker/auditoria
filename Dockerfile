FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ARG APP_URL=https://stack-audit.casahacker.org
ENV APP_URL=$APP_URL
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-por ghostscript
COPY package.json ./
RUN npm install
COPY --from=builder /app/dist ./dist
COPY server.ts feacRoutes.ts diligenciaRoutes.ts kycRoutes.ts kycPdf.ts contratosRoutes.ts ./
COPY src/kyc/kycTypes.ts ./src/kyc/kycTypes.ts
COPY src/contratos/contratosTypes.ts ./src/contratos/contratosTypes.ts
COPY src/contratos/termosCondicoes.ts ./src/contratos/termosCondicoes.ts
COPY src/contratos/jiraClient.ts ./src/contratos/jiraClient.ts
COPY assets ./assets
# #103: commit da plataforma p/ o rodapé/memória do relatório (vazio se não informado no build).
ARG APP_COMMIT=""
ENV APP_COMMIT=$APP_COMMIT
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["npx", "tsx", "server.ts"]
