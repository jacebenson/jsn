ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'tmpdir'
require 'zlib'
class SnapshotsTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    @storage = Dir.mktmpdir('jsn-snapshot-test')
    @previous = ENV['DOCS_STORAGE_DIR']
    ENV['DOCS_STORAGE_DIR'] = @storage
    header 'Host', 'www.example.com'
    @name = "docs-abcdef012345-#{'a' * 64}.sqlite.gz"
    FileUtils.mkdir_p(File.join(@storage, 'snapshots'))
    @bytes = Zlib.gzip('documentation corpus only')
    File.binwrite(File.join(@storage, 'snapshots', @name), @bytes)
    File.write(File.join(@storage, 'snapshots/manifest.json'), {
      revision: 'abcdef012345', url: "https://jsn.jace.pro/docs-index/artifacts/#{@name}"
    }.to_json)
  end
  def teardown
    ENV['DOCS_STORAGE_DIR'] = @previous
    FileUtils.remove_entry(@storage)
  end
  def test_live_manifest_and_download_use_this_service_origin
    get '/docs-index/manifest.json'
    assert_equal 200, last_response.status
    manifest = JSON.parse(last_response.body)
    assert_equal "http://www.example.com/docs-index/artifacts/#{@name}", manifest['url']
    get '/docs-index/download'
    assert_equal 302, last_response.status
    assert_equal manifest['url'], last_response.headers['location']
    get "/docs-index/artifacts/#{@name}"
    assert_equal 200, last_response.status
    assert_equal @bytes, last_response.body.b
    assert_includes last_response.headers['cache-control'], 'immutable'
  end
  def test_unpublished_artifacts_and_non_documentation_files_are_unavailable
    get "/docs-index/artifacts/docs-abcdef012345-#{'b' * 64}.sqlite.gz"
    assert_equal 404, last_response.status
    get '/docs-index/artifacts/production.sqlite3'
    assert_equal 404, last_response.status
  end
end
