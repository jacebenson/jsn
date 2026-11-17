FROM node:lts-bookworm-slim AS assets
WORKDIR /app
COPY site/data/ site/data/
COPY site/static/ site/static/
COPY site/config/ site/config/
COPY site/scripts/build-docs-site.mjs site/scripts/
RUN node site/scripts/build-docs-site.mjs

FROM node:lts-bookworm-slim AS indexer
WORKDIR /app
WORKDIR /app/cli
COPY cli/package.json cli/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY cli/src/ src/
RUN node --input-type=module -e "import Database, { requireFts5 } from './src/sqlite.js'; const db = new Database(':memory:'); requireFts5(db); db.close();"

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
# Only allowlisted Markdown is reachable; contributor evidence is not a static tree.
COPY docs/ /app/docs/
COPY --from=assets /app/site/public ./public
COPY --from=assets /app/site/config/features.json ./config/features.json
COPY --from=assets /app/site/tmp/preserved-urls.json ./tmp/preserved-urls.json
ENV RAILS_ENV=production PORT=3000
RUN groupadd --system jsn && useradd --system --create-home --gid jsn jsn && chown -R jsn:jsn /app/site
USER jsn
EXPOSE 3000
CMD ["sh", "-c", "bin/rails db:prepare && exec bin/serve -b 0.0.0.0"]
