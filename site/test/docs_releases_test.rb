ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'tmpdir'
require 'json'
require 'zlib'

class DocsReleasesTest < Minitest::Test
  include Rack::Test::Methods
  DEFAULT_REVISION = 'aaaaaaa111'.freeze
  BRAZIL_REVISION = 'bbbbbbb222'.freeze
  ZURICH_REVISION = 'ccccccc333'.freeze

  def app = Rails.application

  def setup
    @storage = Dir.mktmpdir('jsn-releases-test')
    @previous = %w[DOCS_STORAGE_DIR DOCS_RELEASES DOCS_SOURCE_BRANCH].to_h { |key| [key, ENV[key]] }
    ENV['DOCS_STORAGE_DIR'] = @storage
    ENV['DOCS_RELEASES'] = 'australia,brazil,zurich'
    ENV.delete('DOCS_SOURCE_BRANCH')
    DocsBuild.delete_all
    header 'Host', 'www.example.com'
    write_index(File.join(@storage), revision: DEFAULT_REVISION, release: 'australia',
      path: 'australia/gliderecord.md', title: 'Default GlideRecord guide', body: 'Default GlideRecord reference.')
    write_index(File.join(@storage, 'releases', 'brazil'), revision: BRAZIL_REVISION, release: 'brazil',
      path: 'brazil/gliderecord.md', title: 'Brazil GlideRecord guide', body: 'Brazil GlideRecord reference.')
    write_index(File.join(@storage, 'releases', 'zurich'), revision: ZURICH_REVISION, release: 'zurich',
      path: 'zurich/gliderecord.md', title: 'Zurich GlideRecord guide', body: 'Zurich GlideRecord reference.')
    write_states(
      'australia' => { 'state' => 'current', 'revision' => DEFAULT_REVISION, 'documents' => 1, 'publishedAt' => '2026-10-01T00:00:00Z' },
      'brazil' => { 'state' => 'current', 'revision' => BRAZIL_REVISION, 'documents' => 1, 'publishedAt' => '2026-10-02T00:00:00Z' },
      'zurich' => { 'state' => 'archived', 'revision' => ZURICH_REVISION, 'documents' => 1, 'publishedAt' => '2026-09-01T00:00:00Z', 'archivedAt' => '2026-09-15T00:00:00Z' }
    )
  end

  def teardown
    @previous.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
    FileUtils.remove_entry(@storage)
  end

  def test_default_release_when_parameter_is_absent
    get '/api/docs/search', q: 'GlideRecord'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'australia', data['release']
    assert_equal 1, data['total']
    assert_equal 'australia/gliderecord.md', data['results'].first['path']
    assert_equal DEFAULT_REVISION, data['revision']
  end

  def test_explicit_release_selection_on_search_read_and_status
    get '/api/docs/search', q: 'GlideRecord', release: 'brazil'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'brazil', data['release']
    assert_equal 'brazil/gliderecord.md', data['results'].first['path']
    assert_equal BRAZIL_REVISION, data['revision']

    get '/api/docs/document', path: 'brazil/gliderecord.md', release: 'brazil'
    assert_equal 200, last_response.status
    document = JSON.parse(last_response.body)
    assert_equal 'brazil', document['release']
    assert_equal BRAZIL_REVISION, document['revision']
    assert_equal 'brazil', document['document']['release']

    get '/api/docs/status', release: 'brazil'
    assert_equal 200, last_response.status
    status = JSON.parse(last_response.body)
    assert_equal 'brazil', status['release']
    assert_equal BRAZIL_REVISION, status['revision']
    assert_equal 1, status['documents']
  end

  def test_unknown_release_is_a_400_with_the_valid_list
    get '/api/docs/search', q: 'GlideRecord', release: 'mars'
    assert_equal 400, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'mars', data['release']
    assert_includes data['error'], 'australia, brazil, zurich'
    assert_equal %w[australia brazil zurich], data['releases']
    get '/api/docs/status', release: 'atlantis'
    assert_equal 400, last_response.status
  end

  def test_malformed_release_shape_is_a_400
    ['Brazil', '../escape', 'a' * 41, 'bra zil'].each do |release|
      get '/api/docs/search', q: 'GlideRecord', release: release
      assert_equal 400, last_response.status, release
      assert_includes JSON.parse(last_response.body)['error'], 'lowercase'
    end
  end

  def test_revision_mismatch_is_evaluated_against_the_requested_family_only
    get '/api/docs/1', revision: DEFAULT_REVISION, release: 'brazil'
    assert_equal 409, last_response.status
    assert_equal 'brazil', JSON.parse(last_response.body)['release']
    get '/api/docs/1', revision: BRAZIL_REVISION, release: 'brazil'
    assert_equal 200, last_response.status
    assert_equal 'brazil', JSON.parse(last_response.body)['release']
    get '/api/docs/1', revision: DEFAULT_REVISION
    assert_equal 200, last_response.status
  end

  def test_missing_family_index_reports_503_and_echoes_the_release
    File.unlink(File.join(@storage, 'releases', 'brazil', 'docs.sqlite3'))
    get '/api/docs/search', q: 'GlideRecord', release: 'brazil'
    assert_equal 503, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'brazil', data['release']
    assert_includes data['error'], 'prepared'
  end

  def test_releases_listing_includes_archived_families
    get '/api/docs/releases'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'australia', data['default']
    rows = data['releases']
    assert_equal %w[australia brazil zurich], rows.map { |row| row['release'] }
    assert_equal [true, false, false], rows.map { |row| row['default'] }
    assert_equal %w[current current archived], rows.map { |row| row['state'] }
    zurich = rows.last
    assert_equal ZURICH_REVISION, zurich['revision']
    assert_equal 1, zurich['documents']
    assert_equal '2026-09-01T00:00:00Z', zurich['publishedAt']
    assert_equal '2026-09-15T00:00:00Z', zurich['archivedAt']
    assert_nil rows.first['archivedAt']
    %w[release default state revision documents publishedAt archivedAt].each do |key|
      assert rows.all? { |row| row.key?(key) }, "missing #{key}"
    end
  end

  def test_missing_state_file_returns_a_stable_empty_list
    File.unlink(File.join(@storage, 'releases.json'))
    get '/api/docs/releases'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal({ 'releases' => [], 'default' => 'australia' }, data)
    get '/documentation'
    assert_equal 200, last_response.status
  end

  def test_promotion_is_scoped_to_its_own_family
    DocsBuild.promote!('australia', DEFAULT_REVISION, manifest('australia', DEFAULT_REVISION))
    DocsBuild.promote!('brazil', BRAZIL_REVISION, manifest('brazil', BRAZIL_REVISION))
    assert_equal %w[australia brazil], DocsBuild.where(active: true).order(:release).pluck(:release)
    DocsBuild.promote!('brazil', 'bbbbbbb999', manifest('brazil', 'bbbbbbb999'))
    assert_equal %w[australia brazil], DocsBuild.where(active: true).order(:release).pluck(:release)
    assert_equal 'bbbbbbb999', DocsBuild.find_by(active: true, release: 'brazil').revision
    assert_raises(ArgumentError) { DocsBuild.promote!('brazil', BRAZIL_REVISION, manifest('australia', BRAZIL_REVISION)) }
    assert_raises(ArgumentError) do
      legacy = manifest('australia', DEFAULT_REVISION).tap { |value| value.delete('release') }
      DocsBuild.promote!('australia', DEFAULT_REVISION, legacy)
    end
  end

  def test_promotion_accepts_preexisting_rows_without_a_release
    DocsBuild.create!(revision: DEFAULT_REVISION, state: 'published', active: true, manifest: manifest('australia', DEFAULT_REVISION).except('release'))
    DocsBuild.promote!('australia', 'aaaaaaa999', manifest('australia', 'aaaaaaa999'))
    assert_equal ['aaaaaaa999'], DocsBuild.where(active: true).pluck(:revision)
  end

  def test_snapshot_manifest_carries_the_release_and_namespaced_artifacts
    name = "docs-#{BRAZIL_REVISION}-#{'a' * 64}.sqlite.gz"
    bytes = Zlib.gzip('brazil documentation corpus')
    dir = File.join(@storage, 'releases', 'brazil', 'snapshots')
    FileUtils.mkdir_p(dir)
    File.binwrite(File.join(dir, name), bytes)
    File.write(File.join(dir, 'manifest.json'), manifest('brazil', BRAZIL_REVISION).merge('url' => "https://jsn.jace.pro/docs-index/artifacts/#{name}").to_json)

    get '/docs-index/releases/brazil/manifest.json'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'brazil', data['release']
    assert_equal BRAZIL_REVISION, data['revision']
    assert_equal "http://www.example.com/docs-index/releases/brazil/artifacts/#{name}", data['url']

    get '/docs-index/releases/brazil/download'
    assert_equal 302, last_response.status
    assert_equal data['url'], last_response.headers['location']

    get "/docs-index/releases/brazil/artifacts/#{name}"
    assert_equal 200, last_response.status
    assert_equal bytes, last_response.body.b
  end

  def test_legacy_default_snapshot_routes_keep_working
    name = "docs-#{DEFAULT_REVISION}-#{'b' * 64}.sqlite.gz"
    bytes = Zlib.gzip('default documentation corpus')
    FileUtils.mkdir_p(File.join(@storage, 'snapshots'))
    File.binwrite(File.join(@storage, 'snapshots', name), bytes)
    File.write(File.join(@storage, 'snapshots', 'manifest.json'),
      manifest('australia', DEFAULT_REVISION).merge('url' => "https://jsn.jace.pro/docs-index/artifacts/#{name}").to_json)

    get '/docs-index/manifest.json'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 'australia', data['release']
    assert_equal "http://www.example.com/docs-index/artifacts/#{name}", data['url']
    get '/docs-index/download'
    assert_equal 302, last_response.status
    get "/docs-index/artifacts/#{name}"
    assert_equal 200, last_response.status
    assert_equal bytes, last_response.body.b
  end

  def test_snapshot_routes_404_for_unknown_families_and_serve_archived_ones
    get '/docs-index/releases/mars/manifest.json'
    assert_equal 404, last_response.status
    name = "docs-#{ZURICH_REVISION}-#{'c' * 64}.sqlite.gz"
    dir = File.join(@storage, 'releases', 'zurich', 'snapshots')
    FileUtils.mkdir_p(dir)
    File.binwrite(File.join(dir, name), Zlib.gzip('archived corpus'))
    File.write(File.join(dir, 'manifest.json'),
      manifest('zurich', ZURICH_REVISION).merge('url' => "https://jsn.jace.pro/docs-index/artifacts/#{name}").to_json)
    get '/docs-index/releases/zurich/manifest.json'
    assert_equal 200, last_response.status
    assert_equal 'zurich', JSON.parse(last_response.body)['release']
    get "/docs-index/releases/zurich/artifacts/#{name}"
    assert_equal 200, last_response.status
  end

  def test_web_reader_and_search_keep_the_requested_release
    get '/documentation', q: 'GlideRecord', release: 'brazil'
    assert_equal 200, last_response.status
    body = last_response.body
    assert_includes body, 'Brazil GlideRecord guide'
    assert_includes body, 'release=brazil'
    assert_includes body, 'name="release"'

    get '/documentation/read', path: 'brazil/gliderecord.md', release: 'brazil'
    assert_equal 200, last_response.status
    body = last_response.body
    assert_includes body, 'Brazil'
    assert_includes body, 'blob/brazil/markdown/brazil/gliderecord.md'
    assert_includes body, 'release=brazil'
    refute_includes body, 'blob/australia/markdown'
  end

  def test_web_release_picker_marks_archived_families
    get '/documentation'
    assert_equal 200, last_response.status
    body = last_response.body
    assert_includes body, '<option value="australia"'
    assert_includes body, '<option value="zurich"'
    assert_includes body, 'Zurich (archived)'
  end

  private

  def manifest(release, revision)
    { 'format' => 1, 'schema' => 1, 'cliCompatibility' => 'docs-schema-1', 'revision' => revision, 'release' => release,
      'sha256' => 'a' * 64, 'compressedBytes' => 100, 'databaseBytes' => 4096, 'documents' => 1,
      'url' => 'https://github.com/example/repo/releases/download/docs/file.gz' }
  end

  def write_states(entries)
    File.write(File.join(@storage, 'releases.json'), JSON.generate(releases: entries.map { |release, state| { 'release' => release }.merge(state) }))
  end

  def write_index(dir, revision:, release:, path:, title:, body:)
    FileUtils.mkdir_p(dir)
    db = SQLite3::Database.new(File.join(dir, 'docs.sqlite3'))
    db.execute_batch(<<~SQL)
      CREATE TABLE docs(id INTEGER PRIMARY KEY, path TEXT, title TEXT, body TEXT, bundle TEXT, doc_type TEXT, release TEXT, frontmatter TEXT);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='id');
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    SQL
    db.execute('INSERT INTO meta VALUES(?, ?)', ['source_revision', revision])
    db.execute('INSERT INTO docs VALUES(1, ?, ?, ?, ?, ?, ?, ?)',
      [path, title, body, 'api', 'reference', release, { description: "#{title} summary.", product: 'API Reference' }.to_json])
    db.execute("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')")
    db.close
    File.write(File.join(dir, 'status.json'), JSON.generate(state: 'ready', revision: revision, documents: 1,
      checkedAt: '2026-10-02T00:00:00Z', publishedAt: '2026-10-02T00:00:00Z'))
  end
end
