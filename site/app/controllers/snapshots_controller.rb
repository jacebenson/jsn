class SnapshotsController < ApplicationController
  def show
    build = DocsBuild.find_by(active: true, state: 'published')
    return render json: { error: 'No published documentation snapshot' }, status: :service_unavailable unless build
    expires_in 5.minutes, public: true
    render json: build.manifest
  end
  def download
    build = DocsBuild.find_by(active: true, state: 'published')
    return head :service_unavailable unless build
    redirect_to build.manifest.fetch('url'), allow_other_host: true
  end
end
