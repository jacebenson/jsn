require 'yaml'
require 'open3'
require 'uri'

# Explicit publication boundary: never derive a filesystem path from a request.
# Markdown lives under site/docs; only the guides allowlist and named feature
# references can be rendered as app routes.
class MarkdownGuide
  DOC_ROOT = Rails.root.join('docs')
  SOURCES = JSON.parse(File.read(Rails.root.join('config/guides.json'))).freeze
  TAGS = %w[h1 h2 h3 h4 h5 h6 p a img ul ol li pre code blockquote strong em del table thead tbody tr th td hr br details summary].freeze
  ATTRIBUTES = %w[href src alt title id class].freeze
  # Source-relative images resolve to the existing public assets. Both the old
  # repository-root spelling and the new site/docs-relative spelling are kept so
  # retained documents do not lose screenshots.
  IMAGES = {
    '../site/static/assets/flow-search-offline.png' => '/assets/flow-search-offline.png',
    '../static/assets/flow-search-offline.png' => '/assets/flow-search-offline.png',
    '../site/static/images/codesearch-graphql-offline-fixture.png' => '/images/codesearch-graphql-offline-fixture.png',
    '../static/images/codesearch-graphql-offline-fixture.png' => '/images/codesearch-graphql-offline-fixture.png',
    'images/updatesets-diff-compact.png' => '/images/updatesets-diff-compact.png',
    '../images/updatesets-diff-compact.png' => '/images/updatesets-diff-compact.png'
  }.freeze
  # Old authored filenames resolve to the consolidated canonical destination.
  # A fragment from the link wins; these defaults preserve topic anchors when a
  # legacy guide was merged into a different titled section.
  SOURCE_ALIASES = {
    'docs-install.md' => %w[install],
    'mid-direct-install.md' => %w[install direct-mid-server-zip-installation],
    'docs-setup.md' => %w[setup],
    'AUTH_LIFECYCLE.md' => %w[setup authentication-lifecycle-review],
    'docs-safety.md' => %w[safety],
    'security-credential-transport.md' => %w[safety credential-destination-policy],
    'safe-flow-edit.md' => %w[safety safe-edits-to-existing-flows],
    'skipped-updates.md' => %w[safety skipped-update-review],
    'mutation-history.md' => %w[safety local-mutation-history-retired],
    'docs-output.md' => %w[output],
    'record-metadata.md' => %w[output dynamic-record-metadata],
    'related-list-counts.md' => %w[output related-list-counts-and-lazy-navigation],
    'docs-agents.md' => %w[agents],
    'cli-guide.md' => %w[cli-guide],
    'flow-designer-interactive.md' => %w[flows flow-designer-interactive-commands],
    'flow-search.md' => %w[flows flow-definition-search],
    'flow-clone.md' => %w[flows clone-an-inactive-draft-flow],
    'legacy-workflow-inspection.md' => %w[flows legacy-workflow-editor-inspection-read-only],
    'record-watch.md' => %w[records watching-a-servicenow-record],
    'records-engine-contract.md' => %w[records records-engine-compatibility-contract],
    'sdk-batch.md' => %w[records optional-sdk-batch-reads],
    'update-set-transfer.md' => %w[updatesets transfer-an-update-set],
    'UPDATESETS_DIFF.md' => %w[updatesets cross-instance-update-set-diff],
    'mid-remote-management.md' => %w[midservers remote-mid-management-over-ssh],
    'store-applications.md' => %w[store store-applications],
    'CODESEARCH_GRAPHQL.md' => ['/features/servicenow-code-search-cli/', 'catalog-and-instance-configuration']
  }.freeze
  SOURCE_ONLY_FILES = {
    'DECISIONS.md' => 'site/docs/maintainers/architecture.md',
    'FEATURE_MAP.md' => 'site/docs/maintainers/architecture.md',
    'STATE.md' => 'site/docs/maintainers/architecture.md',
    'TARGETED_DOCS.md' => 'site/docs/maintainers/architecture.md',
    'docs-distribution-architecture.md' => 'site/docs/maintainers/architecture.md',
    'TEST_AUDIT.md' => 'site/docs/maintainers/testing.md',
    'TEST_AUDIT_CLI_SDK.md' => 'site/docs/maintainers/testing.md',
    'TEST_AUDIT_REMAINING.md' => 'site/docs/maintainers/testing.md',
    'mutation-testing.md' => 'site/docs/maintainers/testing.md',
    'setup-command-parity.md' => 'site/docs/maintainers/testing.md',
    'command-audience-verification.md' => 'site/docs/maintainers/testing.md',
    'command-discovery-parity.md' => 'site/docs/maintainers/testing.md',
    'customization-evidence-parity.md' => 'site/docs/maintainers/testing.md',
    'skill-cli-parity.md' => 'site/docs/maintainers/testing.md',
    'releases.md' => 'site/docs/maintainers/releases.md'
  }.freeze

  def self.all = SOURCES.keys.map { |slug| new(slug) }
  def self.find(slug)
    raise ActiveRecord::RecordNotFound unless SOURCES.key?(slug)
    new(slug)
  end

  # Render a named feature reference from the same publication boundary. The
  # caller supplies a site/docs-relative path from features.json; requests never
  # reach this method with a user-controlled path.
  def self.render_file(relative_path)
    root = DOC_ROOT.realpath
    source = Rails.root.join('docs', relative_path)
    raise ActiveRecord::RecordNotFound unless source.file?
    real = source.realpath
    raise ActiveRecord::RecordNotFound unless real.to_s.start_with?("#{root}#{File::SEPARATOR}")
    text = real.read
    _frontmatter, body = text.match(/\A---\r?\n(.*?)\r?\n---\r?\n(.*)\z/m)&.captures || ['', text]
    clean_html(render_markdown(body), File.basename(relative_path, '.md'))
  end

  def self.render_markdown(body)
    output, error, status = Open3.capture3(ENV.fetch('NODE_BIN', 'node'), Rails.root.join('bin/render-guide.cjs').to_s, stdin_data: body)
    raise "Markdown renderer failed: #{error}" unless status.success?
    output
  end

  attr_reader :slug, :metadata, :body
  def initialize(slug)
    @slug = slug
    source = Rails.root.join('docs', SOURCES.fetch(slug))
    # A replaced symlink must not open a file outside the public source directory.
    root = DOC_ROOT.realpath
    real = source.realpath
    raise ActiveRecord::RecordNotFound unless real.to_s.start_with?("#{root}#{File::SEPARATOR}")
    text = real.read
    frontmatter, @body = text.match(/\A---\r?\n(.*?)\r?\n---\r?\n(.*)\z/m)&.captures || ['', text]
    @metadata = YAML.safe_load(frontmatter, permitted_classes: [], aliases: false) || {}
  rescue Errno::ENOENT
    raise ActiveRecord::RecordNotFound
  end
  def title = metadata.fetch('title') { body[/^#\s+(.+)$/, 1] || slug.tr('-', ' ').capitalize }
  def url = "/docs/#{slug}/"

  def html
    self.class.clean_html(self.class.render_markdown(body), slug)
  end

  def self.clean_html(html, slug)
    sanitized = Rails::HTML5::SafeListSanitizer.new.sanitize(html, tags: TAGS, attributes: ATTRIBUTES)
    fragment = Nokogiri::HTML5.fragment(sanitized)
    # Stable GitHub-style heading fragments, including duplicate headings.
    seen = Hash.new(0)
    fragment.css('h1, h2, h3, h4, h5, h6').each do |heading|
      base = heading.text.downcase.gsub(/[^\p{Alnum}_\-\s]/, '').gsub(/\s/, '-')
      count = seen[base]
      seen[base] += 1
      heading['id'] = count.zero? ? base : "#{base}-#{count}"
    end
    fragment.css('a[href]').each do |link|
      target = safe_link(link['href'], slug)
      target ? link['href'] = target : link.remove_attribute('href')
    end
    fragment.css('img').each do |image|
      target = IMAGES[image['src']]
      target ? image['src'] = target : image.remove
    end
    fragment.to_html.html_safe
  end

  def self.safe_link(href, slug)
    return if href.match?(/[\\\x00-\x20]/) || href.start_with?('//')
    uri = URI.parse(href)
    return href if %w[https http mailto].include?(uri.scheme) && (uri.scheme == 'mailto' || (uri.host.present? && uri.userinfo.nil?))
    return if uri.scheme || uri.path.to_s.split('/').include?('..')
    return href if href.start_with?('#')
    return "/#{href}" if href.match?(%r{\A(?:features(?:/[a-z0-9-]+)?|docs(?:/[a-z0-9-]+)?)/?\z})

    basename = File.basename(uri.path)
    if (target = SOURCE_ALIASES[basename])
      destination, default_fragment = target
      fragment = uri.fragment || default_fragment
      return "#{destination}##{fragment}" if destination.start_with?('/')
      return "/docs/#{destination}/#{fragment ? "##{fragment}" : ''}"
    end
    if (source_only = SOURCE_ONLY_FILES[basename])
      return "https://github.com/jacebenson/jsn/blob/main/#{source_only}#{uri.fragment ? "##{uri.fragment}" : ''}"
    end
    if (evidence = href.match(%r{\A(verification|research)/(.+)\z}))
      return "https://github.com/jacebenson/jsn/blob/main/site/docs/evidence/#{evidence[1]}/#{evidence[2]}"
    end
    # A source-relative link to a published guide resolves to that guide.
    target = SOURCES.key(basename)
    target ||= SOURCES.keys.find { |key| basename == "#{key}.md" }
    return "/docs/#{target}/#{uri.fragment ? "##{uri.fragment}" : ''}" if target
    # Contributor links remain links to source, never implicit publication.
    legacy = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
    source_url = legacy["/#{basename.delete_suffix('.md')}/"]
    return "#{source_url}#{uri.fragment ? "##{uri.fragment}" : ''}" if source_url&.start_with?('https://github.com/jacebenson/jsn/blob/')
    path = uri.path
    return href if path.match?(%r{\A/docs/(#{SOURCES.keys.join('|')})/?\z}) || path == '/docs/'
    return href if path.match?(%r{\A/(?:features(?:/[a-z0-9-]+)?/?|documentation(?:/read)?/?)\z}) || path == '/'
    nil
  rescue URI::InvalidURIError
    nil
  end
end
