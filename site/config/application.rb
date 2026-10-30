require_relative 'boot'
require 'rails'
require 'active_model/railtie'
require 'active_record/railtie'
require 'action_controller/railtie'
Bundler.require(*Rails.groups)
module Site
  class Application < Rails::Application
    config.load_defaults 8.1
    config.api_only = true
    config.public_file_server.enabled = true
    config.public_file_server.headers = { 'cache-control' => 'public, max-age=300' }
  end
end
