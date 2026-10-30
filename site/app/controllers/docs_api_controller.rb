class DocsApiController < ApplicationController
  rate_limit to: 120, within: 1.minute, store: ActiveSupport::Cache::MemoryStore.new,
    with: -> { render json: { error: 'Too many requests. Try again shortly.' }, status: :too_many_requests }
  rescue_from DocumentationIndex::Unavailable, with: ->(e) { render json: { error: e.message }, status: :service_unavailable }
  rescue_from DocumentationIndex::InvalidQuery, with: ->(e) { render json: { error: e.message }, status: :bad_request }
  rescue_from ActiveRecord::RecordNotFound, with: ->(_) { render json: { error: 'Document not found.' }, status: :not_found }
  def search
    DocumentationIndex.open do |index|
      expires_in 1.minute, public: true
      render json: index.search(query: params[:q], limit: params.fetch(:limit, 20), offset: params.fetch(:offset, 0), bundle: params[:bundle])
    end
  end
  def show
    DocumentationIndex.open do |index|
      if params[:revision].present? && params[:revision] != index.revision
        return render json: { error: 'The index changed. Search again or retrieve by path.' }, status: :conflict
      end
      expires_in 1.minute, public: true
      render json: { revision: index.revision, document: index.document(id: params[:id], path: params[:path]) }
    end
  end
  def status
    render json: DocumentationIndex.status
  end
end
