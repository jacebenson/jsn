class GuidesController < BrowserController
  rate_limit to: 120, within: 1.minute, store: ActiveSupport::Cache::MemoryStore.new,
    with: -> { render plain: 'Too many requests. Please try again shortly.', status: :too_many_requests }
  def index
    @guides = MarkdownGuide.all
  end

  def show
    @guide = MarkdownGuide.find(params[:guide])
    @guides = MarkdownGuide.all
  end
end
