class AcceptanceResultsController < BrowserController
  def index
    scope = AcceptanceRun.order(received_at: :desc, id: :desc)
    scope = scope.where(mode: params[:mode]) if %w[readonly pdi].include?(params[:mode])
    # Metadata filters precede the history window; legacy unknowns remain visible.
    candidates = scope.to_a
    @targets = candidates.map(&:target_label).uniq.sort
    @tasksets = candidates.map(&:taskset_version).uniq.sort
    candidates.select! { |run| run.target_label == params[:target] } if params[:target].present?
    candidates.select! { |run| run.taskset_version == params[:taskset] } if params[:taskset].present?
    @families = candidates.map { |run| run.public_metadata.dig('release', 'family') || 'unknown' }.uniq.sort
    @builds = candidates.map { |run| run.public_metadata.dig('release', 'build') || 'unknown' }.uniq.sort
    candidates.select! { |run| (run.public_metadata.dig('release', 'family') || 'unknown') == params[:family] } if params[:family].present?
    candidates.select! { |run| (run.public_metadata.dig('release', 'build') || 'unknown') == params[:build] } if params[:build].present?
    @runs = candidates.first(20)
    @latest = @runs.first
    key = @latest&.comparison_key
    @timings = key ? candidates.select { |run| run.comparison_key == key }.first(20).reverse : []
  end

  def show
    @run = AcceptanceRun.find_by(run_key: params[:run_key])
    return render plain: 'Acceptance run not found.', status: :not_found unless @run
    @local_metadata = @run.public_metadata.presence
    @checks = @run.acceptance_checks.order(:check_id)
    @performance = @run.performance.present? ? JSON.parse(@run.performance) : nil
  rescue JSON::ParserError
    @performance = nil
  end
end
