ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'digest'
require 'tmpdir'

class SubscriptionSchedulesTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    header 'Host', 'www.example.com'
  end

  def test_browse_filter_detail_and_original
    get '/subscription-schedules'
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'Subscription schedules'
    get '/subscription-schedules', q: 'ITOM', product: 'ITOM'
    assert_equal 200, last_response.status
    assert_includes last_response.body, '/subscription-schedules/itom-2026-04-09'
    refute_includes last_response.body, '/subscription-schedules/api-servicenow'
    get '/subscription-schedules/itom-2026-04-09'
    assert_equal 200, last_response.status
    %w[Definitions Ratios Unknowns].each { |word| assert_includes last_response.body, word }
    assert_includes last_response.body, 'https://www.servicenow.com/content/dam/'
    assert_includes last_response.body, 'cmdb_ci_could_database'
    get '/subscription-schedules', q: '<script>alert(1)</script>'
    refute_includes last_response.body, '<script>alert(1)</script>'
    assert_includes last_response.body, '&lt;script&gt;'
    get '/subscription-schedules/no-such-id'
    assert_equal 404, last_response.status
  end

  def test_integrated_normalized_catalog_renders_substantive_fields
    catalog = SubscriptionScheduleCatalog.new
    assert_equal 32, catalog.schedules.length
    assert_equal 28, catalog.schedules.map { |r| r['source_url'] }.uniq.length
    catalog.schedules.each do |record|
      get "/subscription-schedules/#{record['id']}"
      assert_equal 200, last_response.status, record['id']
    end
    get '/subscription-schedules/servicenow-otto-overview'
    assert_includes last_response.body, 'Assist'
    assert_includes last_response.body, 'Section coverage'
    assert_includes last_response.body, 'production AND sub-production'
    get '/subscription-schedules/snc-addendum-integrationhub'
    %w[Packages Entitlements PROD11415 Starter].each { |text| assert_includes last_response.body, text }
    get '/subscription-schedules/custom-table-guide'
    assert_includes last_response.body, 'Grandfathered'
    assert_includes last_response.body, 'not a resource-to-SU meter'
  end

  def test_manifest_exact_bytes_and_cache
    get '/subscription-schedules/v1/manifest.json'
    assert_equal 200, last_response.status
    manifest = JSON.parse(last_response.body)
    assert_equal 1, manifest['schema_version']
    assert_match %r{\Ahttp://www.example.com/}, manifest['catalog_url']
    get URI(manifest['catalog_url']).path
    assert_equal 200, last_response.status
    assert_equal 'application/json', last_response.media_type
    assert_equal manifest['sha256'], Digest::SHA256.hexdigest(last_response.body)
    assert_equal manifest['bytes'], last_response.body.bytesize
    assert_equal manifest['revision'], JSON.parse(last_response.body)['revision']
    assert_includes last_response.headers['cache-control'], 'immutable'
    etag = last_response.headers['etag']
    get URI(manifest['catalog_url']).path, {}, 'HTTP_IF_NONE_MATCH' => etag
    assert_equal 304, last_response.status
    get '/subscription-schedules/v1/artifacts/' + ('0' * 64) + '.json'
    assert_equal 404, last_response.status
    get '/subscription-schedules/v2/manifest.json'
    assert_equal 404, last_response.status
    get '/subscription-schedules/v1/artifacts/%2e%2e%2fGemfile.json'
    assert_equal 404, last_response.status
  end

  def with_catalog(catalog)
    original = SubscriptionScheduleCatalog.method(:new)
    SubscriptionScheduleCatalog.define_singleton_method(:new) { |**_options| catalog }
    yield
  ensure
    SubscriptionScheduleCatalog.define_singleton_method(:new, original)
  end

  def test_source_content_is_escaped_and_additive_fields_survive
    catalog = SubscriptionScheduleCatalog.new
    record = catalog.schedules.first
    record['definitions'] = { 'hostile' => '<script>bad()</script>' }
    record['new_additive_field'] = { 'future' => true }
    with_catalog(catalog) do
      get "/subscription-schedules/#{record['id']}"
      assert_equal 200, last_response.status
      assert_includes last_response.body, '&lt;script&gt;bad()&lt;/script&gt;'
      refute_includes last_response.body, '<script>bad()</script>'
    end
  end

  def test_unavailable_catalog_returns_safe_503
    original = SubscriptionScheduleCatalog.method(:new)
    SubscriptionScheduleCatalog.define_singleton_method(:new) { raise SubscriptionScheduleCatalog::Invalid }
    ['/subscription-schedules', '/subscription-schedules/v1/manifest.json'].each do |path|
      get path
      assert_equal 503, last_response.status
      assert_equal 'no-store', last_response.headers['cache-control']
      refute_includes last_response.body, Rails.root.to_s
    end
  ensure
    SubscriptionScheduleCatalog.define_singleton_method(:new, original)
  end

  def test_invalid_shapes_duplicates_and_unsafe_sources_are_rejected
    Dir.mktmpdir('catalog-') do |dir|
      root = Pathname(dir)
      itom = JSON.parse(Rails.root.join('config/subscription-schedules/itom-2026-04-09.json').read)
      root.join('itom-2026-04-09.json').write(JSON.generate(itom))
      [ [itom], [itom.merge('id' => 'different', 'source_url' => 'javascript:alert(1)')],
        [itom.merge('id' => 'different', 'categories' => 'bad')],
        [itom.merge('id' => '../secret')], [itom.merge('id' => 'different', 'source_url' => 'https://[')] ].each do |records|
        root.join('public-inventory.json').write(JSON.generate(records))
        assert_raises(SubscriptionScheduleCatalog::Invalid) { SubscriptionScheduleCatalog.new(root: root) }
      end
      root.join('public-inventory.json').write(JSON.generate([itom.merge('id' => 'different', 'future' => { 'field' => true })]))
      assert SubscriptionScheduleCatalog.new(root: root).schedules.first['future']['field']
    end
  end

  def test_product_and_version_filters_have_empty_state
    get '/subscription-schedules', product: 'ITOM', version: 'July 23, 2020'
    assert_equal 200, last_response.status
    assert_includes last_response.body, '1 matching records'
    refute_includes last_response.body, '/subscription-schedules/itom-2026-04-09'
    get '/subscription-schedules', q: 'nonexistent-xyz'
    assert_includes last_response.body, 'No matching schedules'
  end

  def test_invalid_catalog_is_unavailable_without_disclosing_files
    Dir.mktmpdir('catalog-') do |dir|
      File.write(File.join(dir, 'public-inventory.json'), '{broken')
      assert_raises(SubscriptionScheduleCatalog::Invalid) { SubscriptionScheduleCatalog.new(root: Pathname(dir)) }
    end
  end
end
