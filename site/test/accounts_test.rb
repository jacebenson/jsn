ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'
class AccountsTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application
  def setup
    LoginSession.delete_all
    User.delete_all
    FeatureVideo.delete_all
    clear_cookies
    header 'Host', 'www.example.com'
  end
  def signup(email = 'owner@example.test')
    User.create!(email: email, password: 'a long test password', admin: !User.exists?)
    post '/login', email: email, password: 'a long test password'
    assert_equal 302, last_response.status
  end
  def test_accounts_sessions_and_admin_video_publication
    get '/'
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'Now make it shippable.'
    assert_includes last_response.body, 'VIDEO COMING SOON'
    get '/account'
    assert_equal 302, last_response.status
    signup
    owner = User.first
    assert owner.admin?
    refute_includes owner.password_digest, 'a long test password'
    get '/account'
    assert_equal 200, last_response.status
    get '/admin'
    assert_equal 200, last_response.status
    slug = Feature.all.first['canonicalSlug']
    patch "/admin/videos/#{slug}", url: 'javascript:alert(1)'
    assert_equal 0, FeatureVideo.count
    patch "/admin/videos/#{slug}", url: 'https://['
    assert_equal 0, FeatureVideo.count
    post "/admin/videos/#{slug}", _method: 'patch', url: 'https://example.test/intro.mp4'
    assert_equal 1, FeatureVideo.count
    get "/features/#{slug}/"
    assert_includes last_response.body, '<video controls'
    post '/admin/videos/introduction', _method: 'patch', url: 'https://example.test/introduction.mp4'
    assert_equal 302, last_response.status
    get '/'
    assert_includes last_response.body, 'https://example.test/introduction.mp4'
    refute_includes last_response.body, 'VIDEO COMING SOON'
    token = rack_mock_session.cookie_jar.to_hash
    post '/logout', _method: 'delete'
    assert_equal 0, LoginSession.count
    token.each { |key, value| set_cookie "#{key}=#{value}" }
    get '/admin'
    assert_equal 302, last_response.status
    clear_cookies
    post '/login', email: owner.email, password: 'wrong password'
    assert_equal 422, last_response.status
    post '/login', email: owner.email.upcase, password: 'a long test password'
    assert_equal 302, last_response.status
    post '/logout', _method: 'delete'
    signup('reader@example.test')
    refute User.last.admin?
    get '/admin'
    assert_equal 403, last_response.status
    patch "/admin/videos/#{slug}", url: 'https://example.test/wrong.mp4'
    assert_equal 403, last_response.status
    assert_equal 'https://example.test/intro.mp4', FeatureVideo.first.url
    LoginSession.update_all(expires_at: 1.day.ago)
    get '/account'
    assert_equal 302, last_response.status
  end
  def test_feature_routes_and_stylesheet
    get '/site.css'
    assert_equal 200, last_response.status
    Feature.all.each do |feature|
      get "/features/#{feature['canonicalSlug']}/"
      assert_equal 200, last_response.status, feature['canonicalSlug']
      assert_includes last_response.body, 'A walkthrough is on the way.'
    end
    get '/features/missing-feature/'
    assert_equal 404, last_response.status
  end
  def test_password_validation_and_csrf
    get '/signup'
    assert_equal 404, last_response.status
    post '/signup', user: { email: 'bad', password: 'short' }
    assert_equal 404, last_response.status
    user = User.new(email: 'test@example.test', password: '12345678')
    assert user.valid?
    user.password = '1234567'
    refute user.valid?
    previous = ActionController::Base.allow_forgery_protection
    ActionController::Base.allow_forgery_protection = true
    post '/login', email: 'test@example.test', password: 'a long test password'
    assert_equal 422, last_response.status
  ensure
    ActionController::Base.allow_forgery_protection = previous
  end
end
