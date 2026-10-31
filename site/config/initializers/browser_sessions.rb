Rails.application.config.middleware.use Rack::MethodOverride
Rails.application.config.middleware.use ActionDispatch::Cookies
Rails.application.config.middleware.use ActionDispatch::Session::CookieStore,
  key: '_jsn_site', httponly: true, same_site: :lax, secure: Rails.env.production?
Rails.application.config.middleware.use ActionDispatch::Flash
