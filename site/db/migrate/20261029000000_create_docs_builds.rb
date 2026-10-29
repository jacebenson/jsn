class CreateDocsBuilds < ActiveRecord::Migration[8.1]
  def change
    create_table :docs_builds do |t|
      t.string :revision, null: false
      t.string :state, null: false
      t.json :manifest
      t.boolean :active, default: false, null: false
      t.timestamps
    end
    add_index :docs_builds, :revision, unique: true
    add_index :docs_builds, :active, unique: true, where: 'active = 1'
  end
end
