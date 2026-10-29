Rails.application.routes.draw do
  get '/up', to: 'rails/health#show', as: :rails_health_check
  get '/docs-index/manifest.json', to: 'snapshots#show'
  get '/docs-index/download', to: 'snapshots#download'
  post '/internal/docs-builds', to: 'builds#create'
  # Preserve links copied from the old GitHub Pages base path on this host.
  get '/jsn(/*path)', to: redirect { |params, request| "/#{params[:path].to_s.sub(/\A\/+/, '')}#{request.query_string.present? ? "?#{request.query_string}" : ''}" }
end
