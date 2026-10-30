class DocumentationController < BrowserController
  # These fixed, public static scripts contain no session data.
  skip_forgery_protection only: :asset
  rate_limit to: 120, within: 1.minute, only: [:index, :show], store: ActiveSupport::Cache::MemoryStore.new,
    with: -> { render plain: 'Too many requests. Please try again shortly.', status: :too_many_requests }
  def asset
    files = {
      'marked' => Rails.root.join('../src/commands/docs/public/vendor/marked.min.js'),
      'purify' => Rails.root.join('../src/commands/docs/public/vendor/purify.min.js'),
      'markdown' => Rails.root.join('app/assets/javascripts/markdown.js'),
      'reader' => Rails.root.join('app/assets/javascripts/documentation.js')
    }
    file = files[params[:asset]] || raise(ActiveRecord::RecordNotFound)
    expires_in 0, public: true
    send_file file, type: 'text/javascript', disposition: 'inline'
  end
  def index
    @query = params[:q].to_s
    @status = DocumentationIndex.status
    if @query.present?
      DocumentationIndex.open { |index| @search = index.search(query: @query, limit: 20, offset: params.fetch(:offset, 0)) }
    end
  rescue DocumentationIndex::InvalidQuery => e
    @error = e.message
    render :index, status: :bad_request
  rescue DocumentationIndex::Unavailable => e
    @error = e.message
    render :index, status: :service_unavailable
  end
  def show
    DocumentationIndex.open { |index| @document = index.document(path: params[:path]) }
  rescue DocumentationIndex::Unavailable => e
    render plain: e.message, status: :service_unavailable
  end
end
