ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'tmpdir'
require 'json'
require 'open3'
require 'fileutils'

class DocsSyncTest < Minitest::Test
  def setup
    @storage = Dir.mktmpdir('jsn-docs-sync-test')
    @source = Dir.mktmpdir('jsn-docs-sync-source')
    @previous = %w[DOCS_STORAGE_DIR DOCS_RELEASES DOCS_SOURCE_BRANCH DOCS_SOURCE_URL].to_h { |key| [key, ENV[key]] }
    ENV['DOCS_STORAGE_DIR'] = @storage
    ENV['DOCS_RELEASES'] = 'australia,brazil,zurich'
    ENV.delete('DOCS_SOURCE_BRANCH')
    ENV.delete('DOCS_SOURCE_URL')
    init_source
  end

  def teardown
    @previous.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
    FileUtils.remove_entry(@storage)
    FileUtils.remove_entry(@source)
  end

  def test_missing_branch_is_archived_while_another_family_publishes
    write_index(DocsStorage.family_dir('zurich'), revision: 'ddddddd444')
    write_states(
      'australia' => { 'state' => 'current', 'revision' => 'aaaaaaa000', 'documents' => 1, 'publishedAt' => '2026-09-01T00:00:00Z' },
      'brazil' => { 'state' => 'current', 'revision' => tips.fetch('brazil'), 'documents' => 1, 'publishedAt' => '2026-09-02T00:00:00Z' },
      'zurich' => { 'state' => 'current', 'revision' => 'ddddddd444', 'documents' => 1, 'publishedAt' => '2026-08-01T00:00:00Z' }
    )
    write_index(DocsStorage.family_dir('brazil'), revision: tips.fetch('brazil'), published_at: '2026-09-02T00:00:00Z')

    calls = []
    runner = lambda do |family, mode|
      calls << [family, mode]
      dir = DocsStorage.family_dir(family)
      published_at = mode == :republish ? JSON.parse(File.read(File.join(dir, 'status.json')))['publishedAt'] : '2026-10-10T00:00:00Z'
      write_index(dir, revision: tips.fetch(family), published_at: published_at)
      [true, nil]
    end

    result = DocsSync.new(source: @source, node_runner: runner, clock: -> { Time.utc(2026, 10, 10) }).run
    assert result[:ok], result.inspect
    assert_equal [%w[australia build], %w[brazil republish]], calls.map { |family, mode| [family, mode.to_s] }

    states = JSON.parse(File.read(File.join(@storage, 'releases.json')))['releases'].to_h { |row| [row['release'], row] }
    assert_equal 'current', states['australia']['state']
    assert_equal tips.fetch('australia'), states['australia']['revision']
    assert_equal 'current', states['brazil']['state']
    assert_equal tips.fetch('brazil'), states['brazil']['revision']
    assert_equal 'archived', states['zurich']['state']
    assert_equal 'ddddddd444', states['zurich']['revision']
    assert_equal '2026-10-10T00:00:00Z', states['zurich']['archivedAt']
    assert File.file?(DocsStorage.index_path('zurich')), 'the archived index must be retained'
    assert File.file?(DocsStorage.index_path('australia')), 'the other family must still publish'
    assert_equal '2026-09-02T00:00:00Z', states['brazil']['publishedAt']
    assert_equal false, result[:results].find { |row| row['release'] == 'brazil' }['changed']
    assert_equal true, result[:results].find { |row| row['release'] == 'australia' }['changed']
  end

  def test_a_failing_family_does_not_stop_the_others_or_erase_its_state
    write_states(
      'australia' => { 'state' => 'current', 'revision' => 'aaaaaaa000', 'documents' => 3, 'publishedAt' => '2026-09-01T00:00:00Z' },
      'brazil' => { 'state' => 'current', 'revision' => 'bbbbbbb000', 'documents' => 1, 'publishedAt' => '2026-09-02T00:00:00Z' }
    )
    write_index(DocsStorage.family_dir('australia'), revision: 'aaaaaaa000')

    runner = lambda do |family, _mode|
      raise 'upstream unavailable' if family == 'australia'

      write_index(DocsStorage.family_dir(family), revision: tips.fetch(family), published_at: '2026-10-11T00:00:00Z')
      [true, nil]
    end

    result = DocsSync.new(source: @source, node_runner: runner, clock: -> { Time.utc(2026, 10, 11) }).run
    refute result[:ok]
    failed = result[:results].find { |row| row['release'] == 'australia' }
    assert_includes failed['error'], 'upstream unavailable'
    states = JSON.parse(File.read(File.join(@storage, 'releases.json')))['releases'].to_h { |row| [row['release'], row] }
    assert_equal 'aaaaaaa000', states['australia']['revision']
    assert_equal 3, states['australia']['documents']
    assert_equal 'current', states['brazil']['state']
    assert_equal tips.fetch('brazil'), states['brazil']['revision']
  end

  def test_a_missing_index_rebuilds_even_when_the_revision_matches
    write_states('brazil' => { 'state' => 'current', 'revision' => tips.fetch('brazil'), 'documents' => 1 })
    calls = []
    runner = lambda do |family, mode|
      calls << [family, mode]
      write_index(DocsStorage.family_dir(family), revision: tips.fetch(family))
      [true, nil]
    end
    DocsSync.new(source: @source, node_runner: runner, clock: -> { Time.utc(2026, 10, 12) }).run
    assert_includes calls, ['brazil', :build]
    refute_includes calls, ['brazil', :republish]
  end

  def test_archived_state_survives_removal_from_the_registry
    write_states(
      'australia' => { 'state' => 'current', 'revision' => 'aaaaaaa000', 'documents' => 1 },
      'yokohama' => { 'state' => 'archived', 'revision' => 'yyyyyyy000', 'documents' => 2, 'archivedAt' => '2026-07-01T00:00:00Z' }
    )
    runner = ->(_family, _mode) { [true, nil] }
    DocsSync.new(source: @source, node_runner: runner, clock: -> { Time.utc(2026, 10, 13) }).run
    states = JSON.parse(File.read(File.join(@storage, 'releases.json')))['releases'].to_h { |row| [row['release'], row] }
    assert_equal 'archived', states['yokohama']['state']
    assert_equal 'yyyyyyy000', states['yokohama']['revision']
    assert_equal '2026-07-01T00:00:00Z', states['yokohama']['archivedAt']
  end

  private

  def tips
    @tips ||= %w[australia brazil].to_h { |branch| [branch, git('ls-remote', '--refs', @source, "refs/heads/#{branch}").split("\t").first] }
  end

  def init_source
    git('init', '-b', 'australia', @source)
    git('-C', @source, 'config', 'user.name', 'Fixture')
    git('-C', @source, 'config', 'user.email', 'fixture@example.test')
    markdown = File.join(@source, 'markdown')
    FileUtils.mkdir_p(markdown)
    File.write(File.join(markdown, 'gliderecord.md'), "# GlideRecord\n\nAustralia guide.\n")
    commit('australia fixture')
    git('-C', @source, 'checkout', '-b', 'brazil')
    File.write(File.join(markdown, 'gliderecord.md'), "# GlideRecord\n\nBrazil guide.\n")
    commit('brazil fixture')
  end

  def commit(message)
    git('-C', @source, 'add', '.')
    git('-C', @source, 'commit', '-m', message)
  end

  def git(*args)
    out, err, status = Open3.capture3('git', *args)
    assert status.success?, err
    out.strip
  end

  def write_states(entries)
    File.write(File.join(@storage, 'releases.json'),
      JSON.generate(releases: entries.map { |release, state| { 'release' => release }.merge(state) }))
  end

  def write_index(dir, revision:, published_at: '2026-10-01T00:00:00Z')
    FileUtils.mkdir_p(dir)
    FileUtils.rm_f(File.join(dir, 'docs.sqlite3'))
    db = SQLite3::Database.new(File.join(dir, 'docs.sqlite3'))
    db.execute_batch(<<~SQL)
      CREATE TABLE docs(id INTEGER PRIMARY KEY, path TEXT, title TEXT, body TEXT, bundle TEXT, doc_type TEXT, release TEXT, frontmatter TEXT);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='id');
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    SQL
    db.execute('INSERT INTO meta VALUES(?, ?)', ['source_revision', revision])
    db.execute('INSERT INTO docs VALUES(1, ?, ?, ?, ?, ?, ?, ?)',
      ['gliderecord.md', 'GlideRecord guide', 'GlideRecord reference.', 'api', 'reference', File.basename(dir), '{}'])
    db.execute("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')")
    db.close
    File.write(File.join(dir, 'status.json'), JSON.generate(state: 'ready', revision: revision, documents: 1,
      checkedAt: published_at, publishedAt: published_at))
  end
end
