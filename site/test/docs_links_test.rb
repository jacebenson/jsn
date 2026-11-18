ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'json'

# The CLI ships only cli/, so site/config/docs-links.json is the authored
# registry and cli/src/docs-links.js is its checked projection. This test proves
# both halves agree and that every documented URL is a real site route.
class DocsLinksTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    header 'Host', 'www.example.com'
  end

  def registry
    JSON.parse(File.read(Rails.root.join('config/docs-links.json')))
  end

  def test_projection_matches_authored_registry_exactly
    source = File.read(Rails.root.join('../cli/src/docs-links.js'))
    assert_includes source, "export const SITE_ORIGIN = '#{registry.fetch('site')}';"
    projected = source.scan(/^\s{2}([a-z-]+): '([^']+)',$/).to_h
    assert_equal registry.fetch('commands'), projected
  end

  def test_every_command_link_is_a_real_site_route
    registry.fetch('commands').each do |command, target|
      path = target.split('#').first
      get path
      assert_equal 200, last_response.status, "#{command} -> #{path}"
      assert_includes last_response.body, 'guide-body', "#{command} -> #{path}"
    end
    get '/features/servicenow-code-search-cli/'
    assert_equal 200, last_response.status
  end

  def test_codesearch_feature_page_owns_the_full_reference_in_closed_details
    get '/features/servicenow-code-search-cli/'
    doc = Nokogiri::HTML(last_response.body)
    details = doc.at_css('details#feature-reference')
    refute_nil details
    refute details.key?('open'), 'deeper reference must be default-closed'
    assert_includes details.at_css('summary').text, 'Full reference'
    text = details.text
    ['jsn codesearch search <term>', 'GraphQL', 'Catalog and instance configuration',
     'Limits and coverage', 'coverage', 'jsn flows search', '--max-requests'].each do |needle|
      assert_includes text, needle
    end
    assert doc.at_css('details#feature-reference .guide-body') || doc.at_css('details#feature-reference')
  end

  def test_legacy_topics_and_source_only_boundary
    {
      '/CODESEARCH_GRAPHQL/' => '/features/servicenow-code-search-cli/#catalog-and-instance-configuration',
      '/flow-search/' => '/docs/flows/#flow-definition-search',
      '/AUTH_LIFECYCLE/' => '/docs/setup/#authentication-lifecycle-review',
      '/TEST_AUDIT/' => 'https://github.com/jacebenson/jsn/blob/main/site/docs/maintainers/testing.md'
    }.each do |old, target|
      get old
      assert_equal 301, last_response.status, old
      assert_includes last_response.headers['location'], target, old
    end
    %w[/docs/STATE /docs/maintainers/architecture /docs/evidence/verification/260-remote-mid].each do |url|
      get url
      assert_equal 404, last_response.status, url
    end
  end
end
