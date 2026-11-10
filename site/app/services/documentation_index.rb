require 'open3'
require 'timeout'
# Thin website adapter: all search SQL and summaries live in the shipped Node service.
class DocumentationIndex
  class Unavailable < StandardError; end
  class InvalidQuery < StandardError; end

  def self.storage(family = nil)
    DocsStorage.family_dir(family || DocsStorage.default_family)
  end

  def self.status(family = nil)
    family ||= DocsStorage.default_family
    DocsStorage.validate_index!(family)
    raw = JSON.parse(File.read(DocsStorage.status_path(family)))
    raise DocsStorage::InvalidIdentity, 'Unreadable documentation status.' unless raw.is_a?(Hash)
    DocsStorage.validate_identity!(raw['release'], family) if raw.key?('release')
    raw.slice('state', 'checkedAt', 'publishedAt', 'documents', 'revision')
  rescue Errno::ENOENT, JSON::ParserError, DocsStorage::InvalidIdentity
    { 'state' => 'unavailable' }
  end

  def self.open(family = nil)
    DocsStorage.validate_index!(family || DocsStorage.default_family)
    worker = Rails.root.join('../cli/src/commands/docs/index-worker.js').to_s
    environment = { 'DOCS_STORAGE_DIR' => storage(family), 'JSN_DOCS_RELEASE' => nil }
    Open3.popen3(environment, ENV.fetch('NODE', 'node'), worker) do |input, output, error, thread|
      begin
        yield new(input, output)
      ensure
        input.close
        output.close
        error.close
        Process.kill('TERM', thread.pid) if thread.alive?
      end
    end
  rescue IOError, SystemCallError, JSON::ParserError, Timeout::Error, DocsStorage::InvalidIdentity
    raise Unavailable, 'Documentation search is temporarily unavailable.'
  end

  def initialize(input, output)
    @input, @output = input, output
  end

  def call(operation, arguments = {})
    response = Timeout.timeout(20) do
      @input.puts(JSON.generate(operation: operation, arguments: arguments))
      @input.flush
      JSON.parse(@output.gets || '{}')
    end
    case response['status']
    when 400 then raise InvalidQuery, response['error']
    when 404 then raise ActiveRecord::RecordNotFound
    when 503 then raise Unavailable, response['error']
    end
    raise Unavailable, 'Documentation search is temporarily unavailable.' unless response.key?('value')

    response['value']
  end

  def revision = call('revision')
  def search(**options) = call('search', options).transform_keys(&:to_sym)
  def document(**options) = call('document', options)
end
