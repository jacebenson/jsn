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

  # The exact original public registry at deedc90: 23 guide routes. Six slugs
  # still have their own page; the other seventeen were consolidated into a
  # retained topic, so /docs/<old-slug>/ must reach that topic and its anchor.
  ORIGINAL_GUIDE_REGISTRY = {
    'install' => nil, 'setup' => nil, 'safety' => nil, 'output' => nil,
    'agents' => nil, 'cli-guide' => nil,
    'flow-designer-interactive' => '/docs/flows/#flow-designer-interactive-commands',
    'flow-search' => '/docs/flows/#flow-definition-search',
    'flow-clone' => '/docs/flows/#clone-an-inactive-draft-flow',
    'legacy-workflow-inspection' => '/docs/flows/#legacy-workflow-editor-inspection-read-only',
    'mid-direct-install' => '/docs/install/#direct-mid-server-zip-installation',
    'mid-remote-management' => '/docs/midservers/#remote-mid-management-over-ssh',
    'mutation-history' => '/docs/safety/#local-mutation-history-retired',
    'record-metadata' => '/docs/output/#dynamic-record-metadata',
    'record-watch' => '/docs/records/#watching-a-servicenow-record',
    'related-list-counts' => '/docs/output/#related-list-counts-and-lazy-navigation',
    'safe-flow-edit' => '/docs/safety/#safe-edits-to-existing-flows',
    'sdk-batch' => '/docs/records/#optional-sdk-batch-reads',
    'skipped-updates' => '/docs/safety/#skipped-update-review',
    'store-applications' => '/docs/store/#servicenow-store-applications',
    'update-set-transfer' => '/docs/updatesets/#transfer-an-update-set',
    'UPDATESETS_DIFF' => '/docs/updatesets/#cross-instance-update-set-diff',
    'CODESEARCH_GRAPHQL' => '/features/servicenow-code-search-cli/#catalog-and-instance-configuration'
  }.freeze

  # Migrated topics that already exist must reach the feature that owns them,
  # not only the CodeSearch page.
  FEATURE_DOC_OWNERSHIP = {
    '/features/servicenow-cli-query-records/' => 'Watching a ServiceNow record',
    '/features/servicenow-record-tools/' => 'Optional SDK batch reads',
    '/features/servicenow-schema-platform-metadata/' => 'Dynamic record metadata',
    '/features/servicenow-flow-debugging-cli/' => 'Flow Designer interactive commands'
  }.freeze

  def registry
    JSON.parse(File.read(Rails.root.join('config/docs-links.json')))
  end

  def test_projection_matches_authored_registry_exactly
    source = File.read(Rails.root.join('../cli/src/docs-links.js'))
    assert_includes source, "export const SITE_ORIGIN = '#{registry.fetch('site')}';"
    assert_includes source, "export const ROOT_DOC_LINK = '#{registry.fetch('root')}';"
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

  # R1: every original public guide route still resolves to real content. A 301
  # to a page that is missing the anchor is not compatibility.
  def test_original_public_guide_registry_routes_survive_with_final_content
    assert_equal 23, ORIGINAL_GUIDE_REGISTRY.length
    ORIGINAL_GUIDE_REGISTRY.each do |slug, target|
      get "/docs/#{slug}/"
      if target.nil?
        assert_equal 200, last_response.status, "/docs/#{slug}/"
        assert_includes last_response.body, 'guide-body', "/docs/#{slug}/"
        next
      end
      assert_equal 301, last_response.status, "/docs/#{slug}/"
      assert_includes last_response.headers['location'], target, "/docs/#{slug}/"
      path, fragment = target.split('#', 2)
      get path
      assert_equal 200, last_response.status, "#{slug} -> #{path}"
      ids = Nokogiri::HTML(last_response.body).css('[id]').map { |node| node['id'] }
      assert_includes ids, fragment, "#{slug} -> #{target} has no ##{fragment}"
    end
  end

  # A compatibility alias must never shadow a page the registry still publishes.
  def test_guide_aliases_do_not_shadow_registered_guides
    aliases = JSON.parse(File.read(Rails.root.join('config/docs-guide-aliases.json')))
    assert_equal 17, aliases.length
    aliases.each_key do |slug|
      refute MarkdownGuide::SOURCES.key?(slug), "#{slug} is both a guide and an alias"
    end
  end

  # R4: a 200 is not enough. Every configured internal legacy target must exist,
  # including its fragment.
  def test_legacy_targets_resolve_to_a_real_page_and_fragment
    legacy = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
    internal = legacy.select { |_old, target| target.start_with?('/') }
    refute_empty internal
    internal.each do |old, target|
      path, fragment = target.split('#', 2)
      get path
      assert_equal 200, last_response.status, "#{old} -> #{path}"
      next unless fragment
      ids = Nokogiri::HTML(last_response.body).css('[id]').map { |node| node['id'] }
      assert_includes ids, fragment, "#{old} -> #{target} has no ##{fragment}"
    end
  end

  # R4: source aliases must point at headings that actually exist.
  def test_source_aliases_name_real_fragments
    MarkdownGuide::SOURCE_ALIASES.each do |source, (destination, fragment)|
      next if destination.start_with?('/')
      next unless fragment
      ids = Nokogiri::HTML.fragment(MarkdownGuide.find(destination).html).css('[id]').map { |node| node['id'] }
      assert_includes ids, fragment, "#{source} -> /docs/#{destination}/##{fragment} does not exist"
    end
  end

  # R4: same-repository source links must point at files this revision keeps.
  def test_same_repository_source_links_point_at_existing_files
    files = Dir[Rails.root.join('docs/guides/*.md')] + Dir[Rails.root.join('docs/maintainers/*.md')]
    refute_empty files
    repo_root = Rails.root.join('..')
    files.each do |file|
      File.read(file).scan(%r{https://github\.com/jacebenson/jsn/blob/main/([^)\s#]+)}) do |(path)|
        assert File.exist?(repo_root.join(path)), "#{File.basename(file)} links to missing #{path}"
      end
    end
    refute_includes File.read(Rails.root.join('docs/guides/install.md')), 'blob/main/docs/'
  end

  # R3: migrated guidance reaches the feature that owns it, not only CodeSearch.
  def test_migrated_feature_pages_own_their_guidance
    FEATURE_DOC_OWNERSHIP.each do |url, needle|
      get url
      assert_equal 200, last_response.status, url
      doc = Nokogiri::HTML(last_response.body)
      assert doc.at_css('.command-example'), "#{url}: quick examples must come first"
      details = doc.at_css('details#feature-reference')
      refute_nil details, "#{url}: no feature reference"
      refute details.key?('open'), "#{url}: deeper reference must be default-closed"
      assert_includes details.text, needle, url
    end
  end
end
