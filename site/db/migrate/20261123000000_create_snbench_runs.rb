class CreateSnbenchRuns < ActiveRecord::Migration[8.1]
  def change
    create_table :snbench_runs do |t|
      t.string :run_id, null: false
      t.string :benchmark, :adapter, :tool, :tool_version, :model, :agent_runner
      t.string :track, null: false
      t.string :instance_build, :commit, :tasks_digest
      t.float :budget_usd
      t.datetime :date, null: false
      t.string :payload_digest, null: false
      t.timestamps
    end
    add_index :snbench_runs, :run_id, unique: true
    create_table :snbench_attempts do |t|
      t.references :snbench_run, null: false, foreign_key: true
      t.string :task, :category, null: false
      t.integer :attempt, null: false
      t.boolean :passed, null: false
      t.json :measurements, null: false
      t.json :checks, null: false
      t.timestamps
    end
    add_index :snbench_attempts, [:snbench_run_id, :task, :attempt], unique: true
  end
end
