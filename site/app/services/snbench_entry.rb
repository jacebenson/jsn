class SnbenchEntry
  attr_reader :key, :runs, :summary
  def initialize(key, runs)
    @key, @runs = key, runs
    @summary = SnbenchSummary.new(runs.flat_map { |run| run.snbench_attempts.to_a })
  end
  def label = [key[1].presence || key[0], key[2], key[3]].compact.join(' / ')
  def score = summary.mean(:pass) * 100
  def per_task_total(metric)
    values = summary.tasks.values.map do |attempts|
      samples = attempts.map { |attempt| attempt.metric(metric) }
      samples.any?(&:nil?) ? nil : samples.sum.to_f
    end
    return nil if values.empty? || values.any?(&:nil?)
    values.sum / values.size
  end
end
