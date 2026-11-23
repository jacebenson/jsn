ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
require 'nokogiri'

class MetadataTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application

  def test_public_pages_have_distinct_metadata_and_production_canonicals
    header 'Host', 'jsn2.jace.pro'
    feature = Feature.all.first
    guide = MarkdownGuide.all.first
    paths = ['/', '/features/', "/features/#{feature.fetch('canonicalSlug')}/", '/docs/', guide.url]
    titles = []
    descriptions = []
    paths.each do |path|
      get "#{path}?utm_source=fixture"
      assert_equal 200, last_response.status, path
      doc = Nokogiri::HTML(last_response.body)
      titles << doc.at_css('title').text
      assert_includes titles.last, 'ServiceNow CLI'
      descriptions << doc.at_css('meta[name=description]')&.[]('content')
      refute_empty descriptions.last.to_s, path
      assert_equal "https://jsn.jace.pro#{path}", doc.at_css('link[rel=canonical]')&.[]('href')
    end
    assert_equal paths.size, titles.uniq.size
    assert_equal paths.size, descriptions.uniq.size
  end

  def test_every_feature_and_guide_has_a_source_backed_description
    header 'Host', 'www.example.com'
    paths = Feature.all.map { |feature| "/features/#{feature.fetch('canonicalSlug')}/" } + MarkdownGuide.all.map(&:url)
    paths.each do |path|
      get path
      assert_equal 200, last_response.status, path
      doc = Nokogiri::HTML(last_response.body)
      refute_empty doc.at_css('meta[name=description]')&.[]('content').to_s, path
      assert_equal "https://jsn.jace.pro#{path}", doc.at_css('link[rel=canonical]')&.[]('href')
    end
  end

  def test_legacy_guides_still_redirect
    header 'Host', 'www.example.com'
    get '/jsn/docs/install/?from=old'
    assert_equal 301, last_response.status
    assert_match %r{/docs/install/?\?from=old}, last_response.headers['location']
  end
end
