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
  # One authored destination registry. Old source filenames and the public
  # legacy redirects both resolve through config/legacy-guide-urls.json, so a
  # destination is written once. The underscore key names the old guide URLs
  # that also serve a compatibility route; it holds URLs, not destinations.
  LEGACY_GUIDE_URLS = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json'))).freeze

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

  # Resolve an authored source filename through the single registry. Old guide
  # filenames use their registry destination (including the default topic
  # anchor); a still-published guide also accepts its docs-<slug>.md spelling.
  def self.source_destination(basename)
    name = basename.delete_suffix('.md')
    return if name == basename
    if (target = LEGACY_GUIDE_URLS["/#{name}/"])&.start_with?('/')
      path, fragment = target.split('#', 2)
      slug = path[%r{\A/docs/([a-z0-9-]+)/\z}, 1] || path
      return [slug, fragment]
    end
    slug = name[/\Adocs-(.+)\z/, 1]
    [slug, nil] if slug && SOURCES.key?(slug)
  end

  def self.safe_link(href, slug)
    return if href.match?(/[\\\x00-\x20]/) || href.start_with?('//')
    uri = URI.parse(href)
    return href if %w[https http mailto].include?(uri.scheme) && (uri.scheme == 'mailto' || (uri.host.present? && uri.userinfo.nil?))
    return if uri.scheme || uri.path.to_s.split('/').include?('..')
    return href if href.start_with?('#')
    return "/#{href}" if href.match?(%r{\A(?:features(?:/[a-z0-9-]+)?|docs(?:/[a-z0-9-]+)?)/?\z})

    basename = File.basename(uri.path)
    if (destination = source_destination(basename))
      slug, default_fragment = destination
      fragment = uri.fragment || default_fragment
      return "#{slug}##{fragment}" if slug.start_with?('/')
      return "/docs/#{slug}/#{fragment ? "##{fragment}" : ''}"
    end
    if (evidence = href.match(%r{\A(verification|research)/(.+)\z}))
      return "https://github.com/jacebenson/jsn/blob/main/site/docs/evidence/#{evidence[1]}/#{evidence[2]}"
    end
    # A source-relative link to a published guide resolves to that guide.
    target = SOURCES.key(basename)
    target ||= SOURCES.keys.find { |key| basename == "#{key}.md" }
    return "/docs/#{target}/#{uri.fragment ? "##{uri.fragment}" : ''}" if target
    # Contributor links, including source-only documents, remain links to the
    # repository source recorded in the registry; never implicit publication.
    source_url = LEGACY_GUIDE_URLS["/#{basename.delete_suffix('.md')}/"]
    return "#{source_url}#{uri.fragment ? "##{uri.fragment}" : ''}" if source_url&.start_with?('https://github.com/jacebenson/jsn/blob/')
    path = uri.path
    return href if path.match?(%r{\A/docs/(#{SOURCES.keys.join('|')})/?\z}) || path == '/docs/'
    return href if path.match?(%r{\A/(?:features(?:/[a-z0-9-]+)?/?|documentation(?:/read)?/?)\z}) || path == '/'
    nil
  rescue URI::InvalidURIError
    nil
  end
end
