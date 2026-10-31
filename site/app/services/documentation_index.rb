require 'open3'
require 'timeout'
# Thin website adapter: all search SQL and summaries live in the shipped Node service.
class DocumentationIndex
  class Unavailable < StandardError; end
  class InvalidQuery < StandardError; end
  def self.storage = ENV.fetch('DOCS_STORAGE_DIR', Rails.root.join('storage/docs').to_s)
  def self.status
    JSON.parse(File.read(File.join(storage, 'status.json'))).slice('state', 'checkedAt', 'publishedAt', 'documents', 'revision')
  rescue Errno::ENOENT, JSON::ParserError
    { 'state' => 'unavailable' }
  end
  def self.open
    worker = Rails.root.join('../cli/src/commands/docs/index-worker.js').to_s
    Open3.popen3({ 'DOCS_STORAGE_DIR' => storage }, ENV.fetch('NODE', 'node'), worker) do |input, output, error, thread|
      begin
        yield new(input, output)
      ensure
        input.close
        output.close
        error.close
        Process.kill('TERM', thread.pid) if thread.alive?
      end
    end
  rescue IOError, SystemCallError, JSON::ParserError, Timeout::Error
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
