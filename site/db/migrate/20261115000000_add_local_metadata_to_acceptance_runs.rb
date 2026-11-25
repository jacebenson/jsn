class AddLocalMetadataToAcceptanceRuns < ActiveRecord::Migration[8.0]
  def change
    add_column :acceptance_runs, :local_metadata, :text
  end
end
