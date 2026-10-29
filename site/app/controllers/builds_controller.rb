class BuildsController < ApplicationController
  before_action :authenticate_publisher
  def create
    revision, state = params[:revision].to_s, params[:state].to_s
    if state == 'published'
      DocsBuild.promote!(revision, params.require(:manifest).to_unsafe_h)
    elsif %w[building failed].include?(state)
      build = DocsBuild.find_or_initialize_by(revision: revision)
      # A retry/failure never demotes the last known-good publication.
      build.update!(state: state) unless build.persisted? && build.state == 'published'
    else
      return render json: { error: 'Invalid build state' }, status: :unprocessable_entity
    end
    head :no_content
  rescue ArgumentError, ActiveRecord::RecordInvalid, ActionController::ParameterMissing
    render json: { error: 'Invalid build metadata' }, status: :unprocessable_entity
  end
  private
  def authenticate_publisher
    expected = ENV['DOCS_PUBLISH_TOKEN'].to_s
    supplied = request.authorization.to_s.delete_prefix('Bearer ')
    head :unauthorized unless expected.present? && ActiveSupport::SecurityUtils.secure_compare(supplied, expected)
  end
end
