Rails.application.routes.draw do
  get '/docs', to: 'guides#index'
  # The original public guide registry had 23 published routes. Consolidated
  # topics keep an exact /docs/<old-slug>/ alias, registered before the
  # catch-all so it wins; only these slugs are reachable, never arbitrary files.
  # Both redirect families derive their destinations from the one authored
  # registry: config/legacy-guide-urls.json. The underscore key only names the
  # old guide URLs that also serve a /docs/<slug>/ compatibility route.
  legacy_urls = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
  legacy_urls.fetch('_docs_guide_aliases').each do |slug|
    target = legacy_urls.fetch("/#{slug}/")
    get "/docs/#{slug}", to: redirect(target, status: 301), format: false
    get "/docs/#{slug}/", to: redirect(target, status: 301), format: false
  end
  get '/docs/*guide', to: 'guides#show', format: false
  legacy_urls.each do |old_url, target|
    next unless old_url.start_with?('/')
    get old_url, to: redirect(target, status: 301)
  end
  get '/results', to: 'acceptance_results#index'
  get '/results/:run_key', to: 'acceptance_results#show'
  post '/api/acceptance/runs', to: 'acceptance_ingest#create'
  get '/site.css', to: 'pages#stylesheet'
  get '/docs-assets/marked.js', to: 'documentation#asset', defaults: { asset: 'marked' }
  get '/docs-assets/purify.js', to: 'documentation#asset', defaults: { asset: 'purify' }
  get '/docs-assets/markdown.js', to: 'documentation#asset', defaults: { asset: 'markdown' }
  get '/docs-assets/reader.js', to: 'documentation#asset', defaults: { asset: 'reader' }
  get '/documentation', to: 'documentation#index'
  get '/documentation/read', to: 'documentation#show'
  get '/api/docs/search', to: 'docs_api#search'
  get '/api/docs/document', to: 'docs_api#show'
  get '/api/docs/status', to: 'docs_api#status'
  get '/api/docs/releases', to: 'docs_api#releases'
  get '/api/docs/:id', to: 'docs_api#show'
  root 'pages#index'
  get '/features', to: 'pages#index'
  get '/features/:slug', to: 'pages#feature'
  get '/login', to: 'accounts#login_form'
  post '/login', to: 'accounts#login'
  get '/account', to: 'accounts#show'
  delete '/logout', to: 'accounts#destroy'
  get '/admin', to: 'admin#index'
  patch '/admin/videos/:slug', to: 'admin#update', as: :admin_video
  get '/up', to: 'rails/health#show', as: :rails_health_check
  get '/docs-index/manifest.json', to: 'snapshots#show'
  get '/docs-index/download', to: 'snapshots#download'
  get '/docs-index/artifacts/:filename', to: 'snapshots#artifact', constraints: { filename: /docs-[a-f0-9]{7,64}-[a-f0-9]{64}\.sqlite\.gz/ }, format: false
  get '/docs-index/releases/:release/manifest.json', to: 'snapshots#show'
  get '/docs-index/releases/:release/download', to: 'snapshots#download'
  get '/docs-index/releases/:release/artifacts/:filename', to: 'snapshots#artifact',
    constraints: { filename: /docs-[a-f0-9]{7,64}-[a-f0-9]{64}\.sqlite\.gz/ }, format: false
  post '/internal/docs-builds', to: 'builds#create'
  # Preserve links copied from the old GitHub Pages base path on this host.
  get '/jsn(/*path)', to: redirect { |params, request| "/#{params[:path].to_s.sub(/\A\/+/, '')}#{request.query_string.present? ? "?#{request.query_string}" : ''}" }
end
