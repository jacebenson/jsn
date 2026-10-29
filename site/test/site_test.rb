ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
class SiteTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    DocsBuild.delete_all
    ENV['DOCS_PUBLISH_TOKEN'] = 'fixture-publisher'
    header 'Host', 'www.example.com'
  end
  def manifest(revision = 'abcdef012345')
    { 'format' => 1, 'schema' => 1, 'cliCompatibility' => 'docs-schema-1', 'revision' => revision,
      'sha256' => 'a' * 64, 'compressedBytes' => 100, 'databaseBytes' => 4096,
      'url' => 'https://github.com/example/repo/releases/download/docs/file.gz' }
  end
  def test_published_manifest_and_failed_build_keep_last_good
    get '/docs-index/manifest.json'
    assert_equal 503, last_response.status
    post '/internal/docs-builds', { revision: 'abcdef012345', state: 'published', manifest: manifest }.to_json, 'CONTENT_TYPE' => 'application/json'
    assert_equal 401, last_response.status
    header 'Authorization', 'Bearer fixture-publisher'
    post '/internal/docs-builds', { revision: 'abcdef012345', state: 'published', manifest: manifest }.to_json, 'CONTENT_TYPE' => 'application/json'
    assert_equal 204, last_response.status
    post '/internal/docs-builds', { revision: 'abcdef987654', state: 'failed' }.to_json, 'CONTENT_TYPE' => 'application/json'
    assert_equal 204, last_response.status
    get '/docs-index/manifest.json'
    assert_equal 200, last_response.status
    assert_equal 'abcdef012345', JSON.parse(last_response.body)['revision']
    get '/docs-index/download'
    assert_equal 302, last_response.status
    assert_match %r{https://github.com/}, last_response.headers['location']
    invalid = manifest('abcdef987654').merge('schema' => 99)
    post '/internal/docs-builds', { revision: 'abcdef987654', state: 'published', manifest: invalid }.to_json, 'CONTENT_TYPE' => 'application/json'
    assert_equal 422, last_response.status
    assert_equal 'abcdef012345', DocsBuild.find_by(active: true).revision
  end
  def test_all_existing_documentation_urls_and_assets
    urls = JSON.parse(File.read(Rails.root.join('tmp/preserved-urls.json')))
    assert_operator urls.length, :>, 10
    urls.each do |url|
      get url
      assert_equal 200, last_response.status, url
      relative = url.delete_prefix('/')
      relative += 'index.html' if relative.empty? || relative.end_with?('/')
      assert_equal File.binread(Rails.root.join('public', relative)), last_response.body.b, url
    end
    %w[/robots.txt /sitemap.xml /css/style.css /assets/webmcp.js].each do |url|
      get url
      assert_equal 200, last_response.status, url
    end
    get '/jsn/docs/install/?from=old'
    assert_equal 301, last_response.status
    assert_match %r{/docs/install/?\?from=old}, last_response.headers['location']
  end
end
