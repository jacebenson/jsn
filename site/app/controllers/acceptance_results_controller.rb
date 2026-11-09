class AcceptanceResultsController < BrowserController
  def index
    @runs = AcceptanceRun.order(received_at: :desc).limit(20)
    @latest = @runs.first
    @timings = if @latest
      AcceptanceRun.where(mode: @latest.mode).order(received_at: :desc).limit(20).to_a.reverse
    else
      []
    end
  end

  def show
    @run = AcceptanceRun.find_by(run_key: params[:run_key])
    return render plain: 'Acceptance run not found.', status: :not_found unless @run
    @checks = @run.acceptance_checks.order(:check_id)
    @performance = @run.performance.present? ? JSON.parse(@run.performance) : nil
  rescue JSON::ParserError
    @performance = nil
  end
end
