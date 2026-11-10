require 'open3'
require 'json'
require 'time'
require 'fileutils'

# Per-family documentation sync. The worker owns the registry loop and the
# release state file; the Node service still owns cloning, ingestion and the
# atomic snapshot publication for one family.
class DocsSync
  def initialize(storage: DocsStorage.base,
    source: ENV.fetch('DOCS_SOURCE_URL', 'https://github.com/ServiceNow/ServiceNowDocs.git'),
    node: ENV.fetch('NODE_BIN', 'node'),
    git_runner: nil, node_runner: nil, clock: -> { Time.now.utc })
    @storage = storage
    @source = source
    @node = node
    @git_runner = git_runner
    @node_runner = node_runner
    @clock = clock
  end

  def run
    FileUtils.mkdir_p(@storage)
    File.open(File.join(@storage, 'sync.lock'), 'a') do |lock|
      unless lock.flock(File::LOCK_EX | File::LOCK_NB)
        return { ok: true, locked: true, results: [] }
      end

      states = DocsStorage.read_states || {}
      results = DocsStorage.families.map do |family|
        begin
          sync_family(family, states)
        rescue StandardError => e
          failure(family, "Sync failed for #{family}: #{e.message}")
        end
      end
      { ok: results.none? { |result| result['error'] }, locked: false, results: results }
    end
  end

  private

  def sync_family(family, states)
    previous = states[family] || {}
    tip, git_error = remote_tip(family)
    return failure(family, git_error) if git_error
    return archive(family, states, previous) if tip.empty?

    stored = previous['revision'].presence || status(family)['revision']
    rebuild = tip != stored || !File.file?(DocsStorage.index_path(family))
    unless rebuild
      ok, error = run_node(family, republish: true)
      return failure(family, error) unless ok
      return publish(family, states, previous, tip, changed: false)
    end

    ok, error = run_node(family, republish: false)
    return failure(family, error) unless ok

    current = status(family)
    return failure(family, 'The sync finished without publishing a ready index.') unless current['state'] == 'ready'

    publish(family, states, previous, current['revision'].presence || tip, changed: true)
  end

  def publish(family, states, previous, revision, changed:)
    current = status(family)
    entry = {
      'state' => 'current',
      'revision' => revision,
      'documents' => current['documents'] || previous['documents'],
      'publishedAt' => current['publishedAt'] || previous['publishedAt'] || @clock.call.iso8601,
      'archivedAt' => nil
    }
    states[family] = entry
    DocsStorage.write_states(states)
    { 'release' => family, 'state' => 'current', 'revision' => entry['revision'],
      'documents' => entry['documents'], 'publishedAt' => entry['publishedAt'],
      'archivedAt' => nil, 'changed' => changed }
  end

  # A missing upstream branch is a normal end-of-life event: keep the last
  # index and record when it was archived. The stored index and artifact are
  # never pruned here.
  def archive(family, states, previous)
    current = status(family)
    entry = {
      'state' => 'archived',
      'revision' => previous['revision'].presence || current['revision'],
      'documents' => previous['documents'] || current['documents'],
      'publishedAt' => previous['publishedAt'] || current['publishedAt'],
      'archivedAt' => previous['archivedAt'].presence || @clock.call.iso8601
    }
    states[family] = entry
    DocsStorage.write_states(states)
    { 'release' => family, 'state' => 'archived', 'revision' => entry['revision'],
      'documents' => entry['documents'], 'publishedAt' => entry['publishedAt'],
      'archivedAt' => entry['archivedAt'], 'changed' => false }
  end

  def failure(family, message)
    { 'release' => family, 'state' => nil, 'error' => message }
  end

  def status(family)
    JSON.parse(File.read(DocsStorage.status_path(family)))
  rescue Errno::ENOENT, JSON::ParserError
    {}
  end

  def remote_tip(family)
    return invoke_git(family) if @git_runner

    out, err, result = Open3.capture3('git', 'ls-remote', '--refs', @source, "refs/heads/#{family}")
    return [nil, "Git ls-remote failed for #{family}: #{err.to_s.lines.last&.strip || result.exitstatus}"] unless result.success?

    [out.split("\t").first.to_s.strip, nil]
  rescue SystemCallError, IOError => e
    [nil, "Git ls-remote failed for #{family}: #{e.message}"]
  end

  def run_node(family, republish:)
    return invoke_node(family, republish ? :republish : :build) if @node_runner

    environment = {
      'DOCS_STORAGE_DIR' => DocsStorage.family_dir(family),
      'DOCS_SOURCE_URL' => @source,
      'DOCS_SOURCE_BRANCH' => family,
      'JSN_DOCS_RELEASE' => nil
    }
    arguments = [@node, Rails.root.join('script/sync-docs.mjs').to_s, family]
    arguments << '--republish' if republish
    out, err, result = Open3.capture3(environment, *arguments, chdir: Rails.root.to_s)
    return [true, nil] if result.success?

    detail = err.to_s.lines.last(3).join.strip
    [false, detail.presence || out.to_s.lines.last(3).join.strip.presence || "Sync failed for #{family}."]
  rescue SystemCallError, IOError => e
    [false, "Sync failed for #{family}: #{e.message}"]
  end

  def invoke_git(family)
    @git_runner.call(family)
  rescue StandardError => e
    [nil, "Git ls-remote failed for #{family}: #{e.message}"]
  end

  def invoke_node(family, mode)
    @node_runner.call(family, mode)
  rescue StandardError => e
    [false, "Sync failed for #{family}: #{e.message}"]
  end
end
