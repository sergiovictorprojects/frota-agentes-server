FROM node:24-slim AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
# Só as dependências de execução; os scripts de instalação (postinstall) não são necessários aqui.
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node 24 executa TypeScript direto (type stripping): não há etapa de build.
CMD ["node", "src/main.ts"]
