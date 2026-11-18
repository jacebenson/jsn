ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'json'
require 'open3'

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

  # Compare the CLI module's actual exported data, not its formatting. The
  # registry is authored here; cli/src/docs-links.js is the checked projection.
  def test_projection_matches_authored_registry_exactly
    module_url = "file://#{Rails.root.join('../cli/src/docs-links.js')}"
    script = <<~JS
      const module = await import(#{module_url.to_json});
      process.stdout.write(JSON.stringify({
        site: module.SITE_ORIGIN,
        root: module.ROOT_DOC_LINK,
        commands: module.DOC_LINKS,
      }));
    JS
    output, error, status = Open3.capture3(
      ENV.fetch('NODE_BIN', 'node'), '--input-type=module', '-e', script
    )
    assert status.success?, "importing the CLI documentation module failed: #{error}"
    projected = JSON.parse(output)
    assert_equal registry.fetch('site'), projected.fetch('site')
    assert_equal registry.fetch('root'), projected.fetch('root')
    assert_equal registry.fetch('commands'), projected.fetch('commands')
  end

  # GLOSSARY: one canonical map per domain concept. Filename rewriting and the
  # public /docs/<old-slug>/ redirects must both derive from the authored URL
  # registry, not from a second destination table.
  def test_migration_destinations_have_one_authored_registry
    refute File.exist?(Rails.root.join('config/docs-guide-aliases.json')),
      'public guide aliases must derive from config/legacy-guide-urls.json'
    refute MarkdownGuide.const_defined?(:SOURCE_ALIASES),
      'filename rewriting must derive destinations from config/legacy-guide-urls.json'
    refute MarkdownGuide.const_defined?(:SOURCE_ONLY_FILES),
      'source-only links must resolve through config/legacy-guide-urls.json'
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
    legacy = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
    aliases = legacy.fetch('_docs_guide_aliases').to_h do |slug|
      [slug, legacy.fetch("/#{slug}/")]
    end
    assert_equal 17, aliases.length
    aliases.each_key do |slug|
      refute MarkdownGuide::SOURCES.key?(slug), "#{slug} is both a guide and an alias"
    end
    # An alias is a URL, not a filename: the .md spelling stays unpublished.
    %w[/docs/flow-search.md /docs/record-watch.md].each do |url|
      get url
      assert_equal 404, last_response.status, url
    end
  end

  # R4: a 200 is not enough. Every configured internal legacy target must exist,
  # including its fragment.
  def test_legacy_targets_resolve_to_a_real_page_and_fragment
    legacy = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
    internal = legacy.select { |old, target| old.start_with?('/') && target.start_with?('/') }
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

  # R4: filenames rewrite through the one authored registry. A caller fragment
  # wins over the registered default; if absent the default topic anchor applies.
  def test_source_filenames_derive_from_the_authored_registry
    legacy = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
    legacy.each do |old_url, target|
      next unless old_url.start_with?('/') && target.start_with?('/')
      name = old_url[%r{\A/([^/]+)/\z}, 1]
      next unless name
      assert_equal target, MarkdownGuide.safe_link("#{name}.md", 'install'), name
      next unless target.include?('#') && target.start_with?('/docs/')
      path, fragment = target.split('#', 2)
      slug = path.split('/')[2]
      ids = Nokogiri::HTML.fragment(MarkdownGuide.find(slug).html).css('[id]').map { |node| node['id'] }
      assert_includes ids, fragment, "#{name}.md -> #{target} does not exist"
    end
  end

  def test_source_link_fragment_precedence_and_source_only_boundary
    assert_equal '/docs/flows/#flow-definition-search',
      MarkdownGuide.safe_link('flow-search.md', 'install')
    assert_equal '/docs/flows/#caller-fragment',
      MarkdownGuide.safe_link('flow-search.md#caller-fragment', 'install')
    assert_equal '/docs/setup/#connect',
      MarkdownGuide.safe_link('./docs-setup.md#connect', 'install')
    assert_equal '/docs/output/', MarkdownGuide.safe_link('docs-output.md', 'install')
    assert_equal '/docs/agents/', MarkdownGuide.safe_link('docs-agents.md', 'install')
    assert_equal 'https://github.com/jacebenson/jsn/blob/main/site/docs/maintainers/architecture.md#decision-log',
      MarkdownGuide.safe_link('DECISIONS.md#decision-log', 'install')
    assert_nil MarkdownGuide.safe_link('../docs-install.md', 'install')
    assert_nil MarkdownGuide.safe_link('arbitrary-file.md', 'install')
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
