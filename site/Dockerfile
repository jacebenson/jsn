FROM node:24-bookworm-slim AS docs
WORKDIR /app
COPY docs/package*.json docs/
RUN npm --prefix docs ci
COPY docs/ docs/
COPY scripts/build-docs-site.mjs scripts/
RUN mkdir -p site/tmp && node scripts/build-docs-site.mjs

FROM node:24-bookworm-slim AS indexer
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/cli
COPY cli/package.json cli/package-lock.json ./
RUN node --input-type=commonjs -e "const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('package.json')); p.allowScripts = {'better-sqlite3@13.0.3': true}; fs.writeFileSync('package.json', JSON.stringify(p));" \
    && npm ci --omit=dev \
    && node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database(':memory:'); db.close();"
COPY cli/src/ src/

FROM ruby:3.4-slim AS service
WORKDIR /app/site
RUN apt-get update && apt-get install --no-install-recommends -y build-essential libyaml-dev libsqlite3-dev git curl && rm -rf /var/lib/apt/lists/*
COPY site/Gemfile site/Gemfile.lock ./
RUN bundle config set without 'development test' && bundle install
COPY --from=indexer /usr/local/bin/node /usr/local/bin/node
COPY --from=indexer /app/cli/package.json /app/cli/package.json
COPY --from=indexer /app/cli/node_modules /app/cli/node_modules
COPY --from=indexer /app/cli/src /app/cli/src
COPY site/ ./
COPY --from=docs /app/site/public ./public
COPY --from=docs /app/site/config/features.json ./config/features.json
COPY --from=docs /app/site/tmp/preserved-urls.json ./tmp/preserved-urls.json
ENV RAILS_ENV=production PORT=3000
RUN groupadd --system jsn && useradd --system --create-home --gid jsn jsn && chown -R jsn:jsn /app/site
USER jsn
EXPOSE 3000
CMD ["sh", "-c", "bin/rails db:prepare && exec bin/serve -b 0.0.0.0"]
