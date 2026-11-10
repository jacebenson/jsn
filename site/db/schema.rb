# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_11_10_120000) do
  create_table "acceptance_checks", force: :cascade do |t|
    t.integer "acceptance_run_id", null: false
    t.string "check_id", null: false
    t.string "status", null: false
    t.integer "duration_ms", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["acceptance_run_id", "check_id"], name: "index_acceptance_checks_on_acceptance_run_id_and_check_id", unique: true
    t.index ["acceptance_run_id"], name: "index_acceptance_checks_on_acceptance_run_id"
  end

  create_table "acceptance_runs", force: :cascade do |t|
    t.string "run_key", null: false
    t.integer "schema_version", null: false
    t.string "mode"
    t.string "cli_version"
    t.string "source_sha"
    t.boolean "source_dirty"
    t.string "node_version"
    t.string "binary_sha256"
    t.string "platform"
    t.string "domain_separation"
    t.boolean "selection_full"
    t.integer "selected_count"
    t.integer "total"
    t.integer "passed"
    t.integer "failed"
    t.integer "blocked"
    t.integer "excluded"
    t.integer "not_run"
    t.boolean "complete"
    t.integer "missing_count"
    t.bigint "duration_ms"
    t.string "payload_digest", null: false
    t.text "performance"
    t.datetime "received_at", default: -> { "CURRENT_TIMESTAMP" }, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["run_key"], name: "index_acceptance_runs_on_run_key", unique: true
  end

  create_table "docs_builds", force: :cascade do |t|
    t.string "revision", null: false
    t.string "state", null: false
    t.json "manifest"
    t.boolean "active", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.string "release"
    t.index ["release", "active"], name: "index_docs_builds_on_release_and_active", unique: true, where: "active = 1"
    t.index ["release", "revision"], name: "index_docs_builds_on_release_and_revision", unique: true
  end

  create_table "feature_videos", force: :cascade do |t|
    t.string "slug", null: false
    t.string "url", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["slug"], name: "index_feature_videos_on_slug", unique: true
  end

  create_table "login_sessions", force: :cascade do |t|
    t.integer "user_id", null: false
    t.string "token_digest", null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["token_digest"], name: "index_login_sessions_on_token_digest", unique: true
    t.index ["user_id"], name: "index_login_sessions_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.string "email", null: false
    t.string "password_digest", null: false
    t.boolean "admin", default: false, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["email"], name: "index_users_on_email", unique: true
  end

  add_foreign_key "acceptance_checks", "acceptance_runs"
  add_foreign_key "login_sessions", "users"
end
