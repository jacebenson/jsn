FROM node:24-bookworm-slim AS docs
WORKDIR /app
COPY docs/package*.json docs/
RUN npm --prefix docs ci
COPY docs/ docs/
COPY scripts/build-docs-site.mjs scripts/
RUN mkdir -p site/tmp && node scripts/build-docs-site.mjs

FROM ruby:3.4-slim AS service
WORKDIR /app/site
RUN apt-get update && apt-get install --no-install-recommends -y build-essential libyaml-dev libsqlite3-dev && rm -rf /var/lib/apt/lists/*
COPY site/Gemfile site/Gemfile.lock ./
RUN bundle config set without 'development test' && bundle install
COPY site/ ./
COPY --from=docs /app/site/public ./public
ENV RAILS_ENV=production PORT=3000
RUN groupadd --system jsn && useradd --system --gid jsn jsn && chown -R jsn:jsn /app/site
USER jsn
EXPOSE 3000
CMD ["sh", "-c", "bin/rails db:prepare && bundle exec puma -C config/puma.rb"]
