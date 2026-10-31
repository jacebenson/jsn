class PagesController < BrowserController
  def stylesheet
    send_file Rails.root.join('app/assets/stylesheets/site.css'), type: 'text/css', disposition: 'inline'
  end
  def index
    @intro_video = FeatureVideo.find_by(slug: 'introduction')
    @features = Feature.all
    @videos = FeatureVideo.all.index_by(&:slug)
  end
  def feature
    @feature = Feature.find(params[:slug])
    @video = FeatureVideo.find_by(slug: params[:slug])
  end
end
