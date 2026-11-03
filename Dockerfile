FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY test ./test
COPY data ./data
COPY REPORT.md README.md ./

ENV NODE_ENV=production
ENV SOLANA_MAINNET_RPC=https://api.mainnet-beta.solana.com

# Default entrypoint runs unit tests + dry-run pipeline + live Mainnet getBlock verification
CMD ["sh", "-c", "node --test test/*.test.mjs && node src/cli.mjs --dry-run && node src/verify_claims.mjs"]
