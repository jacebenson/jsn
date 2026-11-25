class SubscriptionSchedulesController < BrowserController
  before_action :load_catalog
  rescue_from SubscriptionScheduleCatalog::Invalid, with: :unavailable

  def index
    @products = @catalog.schedules.map { |r| r['product'] }.uniq.sort
    @schedules = @catalog.schedules.select do |record|
      (params[:product].blank? || record['product'] == params[:product]) &&
        (params[:q].blank? || JSON.generate(record).downcase.include?(params[:q].to_s.downcase)) &&
        (params[:version].blank? || SubscriptionScheduleCatalog.version(record) == params[:version])
    end
    @versions = @catalog.schedules.map { |r| SubscriptionScheduleCatalog.version(r) }.uniq.sort
  end

  def show
    @schedule = @catalog.schedules.find { |r| r['id'] == params[:id] }
    head :not_found unless @schedule
  end

  def manifest
    response.headers['Cache-Control'] = 'public, max-age=0, must-revalidate'
    render json: { schema_version: 1, revision: @catalog.revision, sha256: @catalog.sha256,
      bytes: @catalog.bytes.bytesize, published_at: @catalog.published_at,
      catalog_url: "#{request.base_url}/subscription-schedules/v1/artifacts/#{@catalog.sha256}.json" }
  end

  def artifact
    return head :not_found unless params[:digest] == @catalog.sha256
    response.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    response.headers['ETag'] = %Q("#{@catalog.sha256}")
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return head :not_modified if request.fresh?(response)
    render body: @catalog.bytes, content_type: 'application/json'
  end

  private

  def load_catalog
    @catalog = SubscriptionScheduleCatalog.new
  end

  def unavailable
    response.headers['Cache-Control'] = 'no-store'
    render plain: 'Schedule catalog temporarily unavailable', status: :service_unavailable
  end
end
