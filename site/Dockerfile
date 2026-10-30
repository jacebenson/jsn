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
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/

FROM ruby:3.4-slim AS service
WORKDIR /app/site
RUN apt-get update && apt-get install --no-install-recommends -y build-essential libyaml-dev libsqlite3-dev git && rm -rf /var/lib/apt/lists/*
COPY site/Gemfile site/Gemfile.lock ./
RUN bundle config set without 'development test' && bundle install
COPY --from=indexer /usr/local/bin/node /usr/local/bin/node
COPY --from=indexer /app/package.json /app/package.json
COPY --from=indexer /app/node_modules /app/node_modules
COPY --from=indexer /app/src /app/src
COPY site/ ./
COPY --from=docs /app/site/public ./public
COPY --from=docs /app/site/config/features.json ./config/features.json
ENV RAILS_ENV=production PORT=3000
RUN groupadd --system jsn && useradd --system --gid jsn jsn && chown -R jsn:jsn /app/site
USER jsn
EXPOSE 3000
CMD ["sh", "-c", "bin/rails db:prepare && exec bin/serve -b 0.0.0.0"]
