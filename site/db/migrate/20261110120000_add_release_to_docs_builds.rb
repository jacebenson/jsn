class AddReleaseToDocsBuilds < ActiveRecord::Migration[8.1]
  def change
    add_column :docs_builds, :release, :string
    remove_index :docs_builds, name: 'index_docs_builds_on_revision'
    remove_index :docs_builds, name: 'index_docs_builds_on_active'
    add_index :docs_builds, %i[release revision], unique: true
    add_index :docs_builds, %i[release active], unique: true, where: 'active = 1'
  end
end
