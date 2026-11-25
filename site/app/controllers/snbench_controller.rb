class SnbenchController < BrowserController
  def index
    scope = SnbenchRun.includes(:snbench_attempts)
    @filters = %w[tool model track].to_h { |key| [key, SnbenchRun.distinct.order(key).pluck(key).compact] }
    @filters.each_key { |key| scope = scope.where(key => params[key]) if params[key].present? }
    @runs = scope.order(date: :desc, run_id: :asc).to_a
    # Keep controls and incompatible tasksets/builds separate, even when filters are absent.
    @groups = @runs.group_by { |run| run.attributes.values_at('track', 'tool', 'model', 'agent_runner', 'benchmark', 'tasks_digest', 'instance_build') }
    @attempt_count = @runs.sum { |run| run.snbench_attempts.size }
    @entries = @groups.map { |key, runs| SnbenchEntry.new(key, runs) }.sort_by { |entry| [-entry.score, entry.label] }
    @x_metrics = { 'cost_usd' => 'Avg cost per task (USD)', 'output' => 'Output tokens per task', 'agent_seconds' => 'Agent seconds per task' }
    @x_metric = @x_metrics.key?(params[:metric]) ? params[:metric] : 'cost_usd'
  end

  def show
    @run = SnbenchRun.includes(:snbench_attempts).find_by(run_id: params[:run_key])
    return render plain: 'snbench run not found.', status: :not_found unless @run
    @summary = SnbenchSummary.new(@run.snbench_attempts.to_a)
  end
end
