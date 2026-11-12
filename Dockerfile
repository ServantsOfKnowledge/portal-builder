FROM node:22-alpine
# git + gh: the launcher shells out to both.
RUN apk add --no-cache git github-cli \
 && git config --system credential.helper '!gh auth git-credential' \
 && git config --system --add safe.directory '*'
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p data workspace && chown node:node data workspace
USER node
ENV HOST=0.0.0.0 PORT=4300
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4300/health || exit 1
CMD ["node", "server.js"]
