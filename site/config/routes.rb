Rails.application.routes.draw do
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
  post '/internal/docs-builds', to: 'builds#create'
  # Preserve links copied from the old GitHub Pages base path on this host.
  get '/jsn(/*path)', to: redirect { |params, request| "/#{params[:path].to_s.sub(/\A\/+/, '')}#{request.query_string.present? ? "?#{request.query_string}" : ''}" }
end
