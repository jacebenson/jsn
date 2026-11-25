# Public task inventory from snbench 0.1.0, tasks_digest 47c881cb73c90e00.
class SnbenchCatalog
  # Reference replication target from the benchmark's --attempts 3 example.
  # Result files do not declare their planned attempt count.
  FULL_ATTEMPTS = 3
  def self.tasks
    JSON.parse(File.read(Rails.root.join('config/snbench_tasks.json'))).sort_by { |task| [task.fetch('category'), task.fetch('id')] }
  end
end
