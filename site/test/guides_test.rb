ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'

class GuidesTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    header 'Host', 'www.example.com'
  end
  def test_real_homepage_and_guides_use_application_layout
    ['/', '/docs', '/docs/', *MarkdownGuide::SOURCES.keys.map { |s| "/docs/#{s}/" }].each do |url|
      get url
      assert_equal 200, last_response.status, url
      doc = Nokogiri::HTML(last_response.body)
      assert_equal 'jsn / ServiceNow, simplified.', doc.at_css('.masthead .brand').text
      assert doc.at_css('link[href^="/site.css"]')
      assert doc.at_css('.footer')
      if url.start_with?('/docs/') && url != '/docs/'
        assert doc.at_css('.guide-body pre code'), url if %w[install setup safety output agents].include?(url.split('/')[2])
        refute_includes doc.at_css('article').text, 'layout: comparison.njk'
      end
    end
  end
  def test_internal_navigation_and_nested_links
    get '/docs/install/'
    doc = Nokogiri::HTML(last_response.body)
    target = doc.at_css('.guide-body a[href="/docs/setup/"]')
    refute_nil target
    get target['href']
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'Connect an instance'
    get '/docs/'
    assert_equal MarkdownGuide::SOURCES.length, Nokogiri::HTML(last_response.body).css('.guide-card').length
    assert_equal '/docs/setup/#connect', MarkdownGuide.safe_link('./docs-setup.md#connect', 'install')
    assert_equal '/docs/output/', MarkdownGuide.safe_link('output.md', 'setup')
  end
  def test_allowlist_rejects_private_and_traversal_paths
    %w[/docs/STATE /docs/DECISIONS.md /docs/../../AGENTS.md /docs/%2e%2e/%2e%2e/etc/passwd /docs/%252e%252e/etc/passwd /docs/install/extra /docs/.env /docs/install.md].each do |url|
      get url
      assert_equal 404, last_response.status, url
    end
    ['../AGENTS.md', '/etc/passwd', 'STATE', nil].each do |slug|
      assert_raises(ActiveRecord::RecordNotFound) { MarkdownGuide.find(slug) }
    end
  end
  def test_sanitization_and_link_policy
    html = MarkdownGuide.clean_html(%q{<script>alert(1)</script><iframe src="https://evil.test"></iframe><svg onload="alert(1)"></svg><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="alert(1)">bad</a><a href="data:text/html,x">data</a><a href="//evil.test">protocol relative</a><a href="file:///etc/passwd">file</a><a href="../STATE.md">private</a><a href="docs-setup.md#connect">setup</a><a href="https://example.com/">external</a><pre><code class="language-sh">jsn version</code></pre>}, 'install')
    doc = Nokogiri::HTML.fragment(html)
    assert_empty doc.css('script, iframe, svg, img, [onclick], [onerror]')
    assert_equal ['/docs/setup/#connect', 'https://example.com/'], doc.css('a[href]').map { |a| a['href'] }
    assert_equal 'jsn version', doc.at_css('pre code').text
    ['javascript:alert(1)', "java\nscript:alert(1)", 'https://user:pass@example.com/', '/docs/../STATE', 'https:\\evil.test'].each do |href|
      assert_nil MarkdownGuide.safe_link(href, 'install'), href
    end
  end
  def test_heading_fragments_images_and_all_guide_links
    html = MarkdownGuide.clean_html('<h2>Connect an instance</h2><h2>Connect an instance</h2><img src="../site/static/images/codesearch-graphql-offline-fixture.png"><img src="https://evil.test/tracker">', 'setup')
    doc = Nokogiri::HTML.fragment(html)
    assert_equal %w[connect-an-instance connect-an-instance-1], doc.css('h2').map { |h| h['id'] }
    assert_equal ['/images/codesearch-graphql-offline-fixture.png'], doc.css('img').map { |image| image['src'] }
    MarkdownGuide.all.each do |guide|
      fragment = Nokogiri::HTML.fragment(guide.html)
      assert_empty fragment.css('a:not([href])'), guide.slug
      fragment.css('a[href]').each do |link|
        uri = URI.parse(link['href'])
        next if uri.scheme || !uri.fragment || uri.path.to_s.empty?
        slug = uri.path.split('/')[2]
        target = MarkdownGuide.find(slug)
        ids = Nokogiri::HTML.fragment(target.html).css('[id]').map { |node| node['id'] }
        assert_includes ids, uri.fragment, "#{guide.slug}: #{link['href']}"
      end
    end
    assert_nil MarkdownGuide.safe_link('../docs-install.md', 'setup')
    assert_nil MarkdownGuide.safe_link('/documentation-evil', 'setup')
  end

  def test_service_now_reader_stays_separate
    get '/documentation'
    assert_equal 200, last_response.status
    refute_includes last_response.body, 'THE JSN HANDBOOK'
  end
end
