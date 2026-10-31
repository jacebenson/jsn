ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'tmpdir'
class DocumentationTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    @storage = Dir.mktmpdir('jsn-documentation-test')
    @previous = ENV['DOCS_STORAGE_DIR']
    ENV['DOCS_STORAGE_DIR'] = @storage
    db = SQLite3::Database.new(File.join(@storage, 'docs.sqlite3'))
    db.execute_batch(<<~SQL)
      CREATE TABLE docs(id INTEGER PRIMARY KEY, path TEXT, title TEXT, body TEXT, bundle TEXT, doc_type TEXT, release TEXT, frontmatter TEXT);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='id');
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES('source_revision', 'fixture123');
    SQL
    db.execute('INSERT INTO docs VALUES(1, ?, ?, ?, ?, ?, ?, ?)', ['api/gliderecord.md', 'GlideRecord guide', "# GlideRecord\n\nFind records.\n\n<script>alert('xss')</script>", 'api', 'reference', 'australia', { description: 'Query and update ServiceNow records with the GlideRecord API.', product: 'API Reference' }.to_json])
    db.execute("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')")
    db.close
    clear_cookies
    header 'Host', 'www.example.com'
  end
  def teardown
    ENV['DOCS_STORAGE_DIR'] = @previous
    FileUtils.remove_entry(@storage)
  end
  def test_public_search_read_and_revision_contract
    get '/api/docs/search', q: 'GlideRecord'
    assert_equal 200, last_response.status
    data = JSON.parse(last_response.body)
    assert_equal 1, data['total']
    assert_equal 'fixture123', data['revision']
    assert_equal 'api/gliderecord.md', data['results'].first['path']
    refute data['results'].first.key?('body')
    assert_equal 'Query and update ServiceNow records with the GlideRecord API.', data['results'].first['summary']
    assert_equal 'description', data['results'].first['summary_source']
    refute data['results'].first.key?('frontmatter')
    refute data['results'].first.key?('preview')
    get '/api/docs/document', path: 'api/gliderecord.md'
    assert_equal 200, last_response.status
    assert_includes JSON.parse(last_response.body)['document']['body'], 'Find records.'
    get '/api/docs/1', revision: 'old-revision'
    assert_equal 409, last_response.status
    get '/api/docs/1', revision: 'fixture123'
    assert_equal 200, last_response.status
    get '/api/docs/document', path: '../../etc/passwd'
    assert_equal 404, last_response.status
    get '/documentation', q: 'GlideRecord'
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'GlideRecord guide'
    assert_includes last_response.body, 'Query and update ServiceNow records'
    assert_includes last_response.body, '<mark>GlideRecord</mark>'
    get '/documentation/read', path: 'api/gliderecord.md'
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'Find records.'
    refute_includes last_response.body, "<script>alert('xss')</script>"
  end
  def test_public_reader_assets
    previous = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    %w[marked purify markdown reader].each do |asset|
      get "/docs-assets/#{asset}.js"
      assert_equal 200, last_response.status
      assert_includes last_response.content_type, 'javascript'
    end
  ensure
    ActionController::Base.allow_forgery_protection = previous
  end
  def test_validation_empty_results_and_unavailable_index
    get '/api/docs/search', q: '" OR *'
    assert_equal 200, last_response.status
    get '/api/docs/search', q: 'somethingabsent'
    assert_equal 0, JSON.parse(last_response.body)['total']
    ['', 'x' * 201, '***'].each do |query|
      get '/api/docs/search', q: query
      assert_equal 400, last_response.status
    end
    get '/api/docs/search', q: 'GlideRecord', limit: 1000
    assert_equal 400, last_response.status
    get '/api/docs/search', q: 'GlideRecord', offset: -1
    assert_equal 400, last_response.status
    File.unlink(File.join(@storage, 'docs.sqlite3'))
    get '/api/docs/search', q: 'GlideRecord'
    assert_equal 503, last_response.status
    assert_includes JSON.parse(last_response.body)['error'], 'prepared'
    get '/documentation', q: 'GlideRecord'
    assert_equal 503, last_response.status
  end
end
