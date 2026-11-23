class SnbenchAttempt < ApplicationRecord
  belongs_to :snbench_run
  validates :task, :category, :attempt, presence: true

  def metric(key)
    case key
    when :pass then passed ? 1.0 : 0.0
    when :input, :output then measurements.dig('tokens', key.to_s)
    else measurements[key.to_s]
    end
  end
end
