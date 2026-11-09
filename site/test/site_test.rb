ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'nokogiri'
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

class FeatureVideosTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application

  def setup
    FeatureVideo.delete_all
    LoginSession.delete_all
    User.delete_all
    clear_cookies
    header 'Host', 'www.example.com'
    @slug = Feature.all.first['canonicalSlug']
  end

  def teardown
    FeatureVideo.delete_all
    LoginSession.delete_all
    User.delete_all
  end

  def test_youtube_url_forms_and_start_offsets
    {
      'https://youtu.be/dQw4w9WgXcQ' => 0,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared&t=90' => 90,
      'https://youtube.com/embed/dQw4w9WgXcQ?start=42' => 42,
      'https://m.youtube.com/shorts/dQw4w9WgXcQ?t=1m30s' => 90,
      'https://youtu.be/dQw4w9WgXcQ?t=1h2m3s' => 3723,
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=oops' => 0,
      'https://youtu.be/dQw4w9WgXcQ?start=-5' => 0
    }.each do |url, start|
      video = FeatureVideo.new(slug: @slug, url: url)
      assert video.valid?, url
      assert_equal :youtube, video.provider, url
      assert_equal 'dQw4w9WgXcQ', video.provider_id, url
      assert_equal start, video.start_seconds, url
    end
  end

  def test_joomdeck_url_forms
    %w[https://joomdeck.com/r/lfxczeq1rg https://joomdeck.com/r/lfxczeq1rg/video https://joomdeck.com/r/lfxczeq1rg/embed].each do |url|
      video = FeatureVideo.new(slug: @slug, url: url)
      assert video.valid?, url
      assert_equal :joomdeck, video.provider, url
      assert_equal 'lfxczeq1rg', video.provider_id, url
    end
  end

  def test_files_and_unknown_or_unrecognized_https_links
    %w[https://example.test/movie.mp4 https://example.test/movie.WEBM?token=abc].each do |url|
      video = FeatureVideo.new(slug: @slug, url: url)
      assert video.valid?, url
      assert_equal :file, video.provider, url
    end
    %w[https://example.test/watch https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ https://evil.test/r/lfxczeq1rg https://joomdeck.com.evil.test/r/lfxczeq1rg https://youtu.be/not-an-id https://youtube.com/watch https://youtube.com/embed/invalid https://joomdeck.com/r/ https://joomdeck.com/r/slug/other https://joomdeck.com/r/slug%22].each do |url|
      video = FeatureVideo.new(slug: @slug, url: url)
      assert video.valid?, url
      assert_equal :link, video.provider, url
    end
  end

  def test_invalid_urls_are_rejected_and_never_embedded
    ['javascript:alert(1)', 'data:text/html,hello', 'http://youtu.be/dQw4w9WgXcQ', 'garbage', 'https://[', 'https:///watch', 'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ', ''].each do |url|
      video = FeatureVideo.new(slug: @slug, url: url)
      refute video.valid?, url
      assert_equal :link, video.provider, url
    end
  end

  def test_provider_is_derived_from_the_current_url
    video = FeatureVideo.new(slug: @slug, url: 'https://youtu.be/dQw4w9WgXcQ')
    assert_equal :youtube, video.provider
    video.url = 'https://joomdeck.com/r/lfxczeq1rg'
    assert_equal :joomdeck, video.provider
    assert_equal 'lfxczeq1rg', video.provider_id
  end

  def test_both_pages_render_provider_players_and_link_fallback
    [[@slug, "/features/#{@slug}/", '.video-panel'], ['introduction', '/', '.intro-video']].each do |slug, path, container|
      video = FeatureVideo.create!(slug: slug, url: 'https://youtu.be/dQw4w9WgXcQ?t=90')
      get path
      assert_equal 200, last_response.status
      doc = Nokogiri::HTML(last_response.body)
      iframe = doc.at_css("#{container} iframe")
      refute_nil iframe
      assert_equal 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&playsinline=1&start=90', iframe['src']
      assert_equal 'lazy', iframe['loading']
      assert_equal 'strict-origin-when-cross-origin', iframe['referrerpolicy']
      assert iframe.key?('allowfullscreen')
      refute_empty iframe['allow']
      refute_empty iframe['title']
      assert_empty doc.css('video')

      video.update!(url: 'https://joomdeck.com/r/lfxczeq1rg')
      get path
      iframe = Nokogiri::HTML(last_response.body).at_css("#{container} iframe")
      assert_equal 'https://joomdeck.com/r/lfxczeq1rg/embed', iframe['src']
      assert_equal '960', iframe['width']
      assert_equal '540', iframe['height']
      assert_equal '0', iframe['frameborder']
      assert_equal 'lazy', iframe['loading']
      assert iframe.key?('allowfullscreen')

      video.update!(url: 'https://example.test/watch')
      get path
      doc = Nokogiri::HTML(last_response.body)
      assert_empty doc.css('iframe, video')
      link = doc.at_css("#{container} a.button")
      assert_equal video.url, link['href']
      assert_match /Watch the (walkthrough|introduction)/, link.text

      video.update!(url: 'https://example.test/movie.mp4')
      get path
      player = Nokogiri::HTML(last_response.body).at_css("#{container} video")
      assert_equal video.url, player['src']
      assert_equal 'metadata', player['preload']
      assert player.key?('controls')
    end
  end

  def test_admin_save_detected_provider_and_invalid_update
    User.create!(email: 'video-admin@example.test', password: 'a long test password', admin: true)
    post '/login', email: 'video-admin@example.test', password: 'a long test password'
    assert_equal 302, last_response.status
    {
      'https://youtu.be/dQw4w9WgXcQ' => 'YouTube - dQw4w9WgXcQ',
      'https://joomdeck.com/r/lfxczeq1rg/video' => 'JoomDeck - lfxczeq1rg',
      'https://example.test/intro.mp4' => 'MP4 file',
      'https://example.test/intro.webm' => 'WebM file',
      'https://example.test/watch' => 'External link'
    }.each do |url, label|
      patch "/admin/videos/#{@slug}", url: url
      assert_equal 302, last_response.status
      assert_equal url, FeatureVideo.find_by!(slug: @slug).url
      follow_redirect!
      assert_equal 200, last_response.status
      assert_includes last_response.body, label
    end
    patch "/admin/videos/#{@slug}", url: 'javascript:alert(1)'
    follow_redirect!
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'YouTube'
    assert_includes last_response.body, 'JoomDeck'
    assert_equal 'https://example.test/watch', FeatureVideo.find_by!(slug: @slug).url
    patch "/admin/videos/#{@slug}", url: ''
    follow_redirect!
    assert_equal 200, last_response.status
    refute FeatureVideo.exists?(slug: @slug)
  end
end
