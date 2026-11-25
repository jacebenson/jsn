class CreateAcceptanceResults < ActiveRecord::Migration[8.1]
  def change
    create_table :acceptance_runs do |t|
      t.string :run_key, null: false
      t.integer :schema_version, null: false
      t.string :mode, :cli_version, :source_sha
      t.boolean :source_dirty
      t.string :node_version, :binary_sha256, :platform, :domain_separation
      t.boolean :selection_full
      t.integer :selected_count, :total, :passed, :failed, :blocked, :excluded, :not_run
      t.boolean :complete
      t.integer :missing_count
      t.bigint :duration_ms
      t.string :payload_digest, null: false
      t.text :performance
      t.datetime :received_at, null: false, default: -> { 'CURRENT_TIMESTAMP' }
      t.timestamps
    end
    add_index :acceptance_runs, :run_key, unique: true
    create_table :acceptance_checks do |t|
      t.references :acceptance_run, null: false, foreign_key: true
      t.string :check_id, null: false
      t.string :status, null: false
      t.integer :duration_ms, null: false
      t.timestamps
    end
    add_index :acceptance_checks, [:acceptance_run_id, :check_id], unique: true
  end
end
