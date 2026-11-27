class SnbenchRun < ApplicationRecord
  has_many :snbench_attempts, dependent: :delete_all
  validates :run_id, presence: true, format: { with: /\A[a-zA-Z0-9_-]+\z/ }
  validates :track, inclusion: { in: %w[agent oracle nop] }
  validates :date, presence: true

  # Immutable snapshots: retries are no-ops, conflicting identities fail closed.
  def self.ingest(payload)
    digest = Digest::SHA256.hexdigest(JSON.generate(canonical(payload)))
    transaction do
      existing = find_by(run_id: payload.fetch('run_id'))
      if existing
        raise ArgumentError, 'run_id conflicts with stored snapshot' unless existing.payload_digest == digest
        return existing
      end
      run = create!(payload.slice('run_id', 'benchmark', 'adapter', 'tool', 'tool_version', 'track', 'model',
        'agent_runner', 'budget_usd', 'instance_build', 'commit', 'tasks_digest', 'date').merge('payload_digest' => digest))
      payload.fetch('attempts').each do |attempt|
        raise ArgumentError, 'pass must be boolean' unless [true, false].include?(attempt.fetch('pass'))
        run.snbench_attempts.create!(task: attempt.fetch('task'), category: attempt.fetch('category'),
          attempt: attempt.fetch('attempt'), passed: attempt.fetch('pass'), checks: attempt.fetch('checks'),
          measurements: attempt.except('task', 'category', 'attempt', 'pass', 'checks', 'agent_command'))
      end
      raise ArgumentError, 'run must contain attempts' if run.snbench_attempts.empty?
      run
    end
  end

  def self.canonical(value)
    case value
    when Hash then value.sort.to_h.transform_values { |v| canonical(v) }
    when Array then value.map { |v| canonical(v) }
    else value
    end
  end
end
