class AdminController < BrowserController
  before_action :require_admin
  def index
    @sync_status = DocumentationIndex.status
    @features = [{ 'id' => 'introduction', 'title' => 'Homepage introduction', 'canonicalSlug' => 'introduction' }] + Feature.all
    @videos = FeatureVideo.all.index_by(&:slug)
  end
  def update
    Feature.find(params[:slug]) unless params[:slug] == 'introduction'
    video = FeatureVideo.find_or_initialize_by(slug: params[:slug])
    if params[:url].blank?
      video.destroy! if video.persisted?
    else
      video.update!(url: params[:url].to_s.strip)
    end
    redirect_to admin_path, notice: 'Video saved.'
  rescue ActiveRecord::RecordInvalid
    redirect_to admin_path, alert: 'Use a full HTTPS video or watch-page URL.'
  end
end
