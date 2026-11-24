# Each distinct task has equal weight, regardless of its attempt count.
class SnbenchSummary
  attr_reader :tasks

  def initialize(attempts)
    @tasks = attempts.group_by(&:task)
  end

  def mean(key)
    values = tasks.values.map do |attempts|
      samples = attempts.map { |attempt| attempt.metric(key) }
      next nil if samples.any?(&:nil?)
      samples.sum.to_f / samples.size
    end
    return nil if values.empty? || values.any?(&:nil?)
    values.sum / values.size
  end

  def passed = tasks.values.sum { |attempts| attempts.count(&:passed).to_f / attempts.size }
  def attempted = tasks.size
end
