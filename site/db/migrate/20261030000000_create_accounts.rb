class CreateAccounts < ActiveRecord::Migration[8.1]
  def change
    create_table :users do |t|
      t.string :email, null: false
      t.string :password_digest, null: false
      t.boolean :admin, null: false, default: false
      t.timestamps
    end
    add_index :users, :email, unique: true
    create_table :login_sessions do |t|
      t.references :user, null: false, foreign_key: true
      t.string :token_digest, null: false
      t.datetime :expires_at, null: false
      t.timestamps
    end
    add_index :login_sessions, :token_digest, unique: true
    create_table :feature_videos do |t|
      t.string :slug, null: false
      t.string :url, null: false
      t.timestamps
    end
    add_index :feature_videos, :slug, unique: true
  end
end
