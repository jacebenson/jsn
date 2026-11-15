require 'yaml'
require 'open3'
require 'uri'

# Explicit publication boundary: never derive a filesystem path from a request.
class MarkdownGuide
  SOURCES = JSON.parse(File.read(Rails.root.join('config/guides.json'))).freeze
  TAGS = %w[h1 h2 h3 h4 h5 h6 p a img ul ol li pre code blockquote strong em del table thead tbody tr th td hr br details summary].freeze
  ATTRIBUTES = %w[href src alt title id class].freeze
  IMAGES = {
    '../site/static/assets/flow-search-offline.png' => '/assets/flow-search-offline.png',
    '../site/static/images/codesearch-graphql-offline-fixture.png' => '/images/codesearch-graphql-offline-fixture.png',
    'images/updatesets-diff-compact.png' => '/images/updatesets-diff-compact.png'
  }.freeze

  def self.all = SOURCES.keys.map { |slug| new(slug) }
  def self.find(slug)
    raise ActiveRecord::RecordNotFound unless SOURCES.key?(slug)
    new(slug)
  end

  attr_reader :slug, :metadata, :body
  def initialize(slug)
    @slug = slug
    source = Rails.root.join('../docs', SOURCES.fetch(slug))
    # A replaced symlink must not open a file outside the public source directory.
    raise ActiveRecord::RecordNotFound unless source.realpath.dirname == Rails.root.join('../docs').realpath
    text = source.read
    frontmatter, @body = text.match(/\A---\r?\n(.*?)\r?\n---\r?\n(.*)\z/m)&.captures || ['', text]
    @metadata = YAML.safe_load(frontmatter, permitted_classes: [], aliases: false) || {}
  end
  def title = metadata.fetch('title') { body[/^#\s+(.+)$/, 1] || slug.tr('-', ' ').capitalize }
  def url = "/docs/#{slug}/"

  def html
    output, error, status = Open3.capture3(ENV.fetch('NODE_BIN', 'node'), Rails.root.join('bin/render-guide.cjs').to_s, stdin_data: body)
    raise "Markdown renderer failed: #{error}" unless status.success?
    self.class.clean_html(output, slug)
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
    return 'https://github.com/jacebenson/jsn/blob/main/docs/verification/260-remote-mid.md' if href == 'verification/260-remote-mid.md'
    # Source-relative Markdown links resolve only to published guides.
    basename = File.basename(uri.path)
    target = SOURCES.key(basename)
    target ||= SOURCES.keys.find { |key| basename == "#{key}.md" }
    return "/docs/#{target}/#{uri.fragment ? "##{uri.fragment}" : ''}" if target
    # Contributor links remain links to source, never implicit publication.
    legacy = JSON.parse(File.read(Rails.root.join('config/legacy-guide-urls.json')))
    source_url = legacy["/#{basename.delete_suffix('.md')}/"]
    return "#{source_url}#{uri.fragment ? "##{uri.fragment}" : ''}" if source_url&.start_with?('https://github.com/jacebenson/jsn/blob/main/docs/')
    path = uri.path
    return href if path.match?(%r{\A/docs/(#{SOURCES.keys.join('|')})/?\z}) || path == '/docs/'
    return href if path.match?(%r{\A/(?:features(?:/[a-z0-9-]+)?/?|documentation(?:/read)?/?)\z}) || path == '/'
    nil
  rescue URI::InvalidURIError
    nil
  end
end
