# One place that turns a documentation release family into its storage paths.
# The default family keeps the original flat layout; every other family is
# additive under releases/<family>/ and is never rewritten in place.
require 'fileutils'

class DocsStorage
  FAMILY = /\A[a-z0-9-]{1,40}\z/
  DEFAULT_FAMILY = 'australia'.freeze

  class UnknownRelease < StandardError; end

  class << self
    def base
      ENV.fetch('DOCS_STORAGE_DIR', Rails.root.join('storage/docs').to_s)
    end

    def families
      configured = ENV['DOCS_RELEASES'].to_s.split(',').map(&:strip).reject(&:empty?)
      valid = configured.select { |family| FAMILY.match?(family) }.uniq
      valid.presence || [ENV['DOCS_SOURCE_BRANCH'].presence || DEFAULT_FAMILY]
    end

    def default_family
      families.first
    end

    def valid?(family)
      families.include?(family.to_s)
    end

    def resolve!(family)
      requested = family.to_s.strip
      requested = default_family if requested.empty?
      raise UnknownRelease, 'Release must contain 1–40 lowercase letters, digits or dashes.' unless FAMILY.match?(requested)
      raise UnknownRelease, "Unknown release. Valid releases: #{families.join(', ')}." unless valid?(requested)

      requested
    end

    def family_dir(family = default_family)
      family == default_family ? base : File.join(base, 'releases', family)
    end

    def index_path(family = default_family)
      File.join(family_dir(family), 'docs.sqlite3')
    end

    def status_path(family = default_family)
      File.join(family_dir(family), 'status.json')
    end

    def snapshots_dir(family = default_family)
      File.join(family_dir(family), 'snapshots')
    end

    def manifest_path(family = default_family)
      File.join(snapshots_dir(family), 'manifest.json')
    end

    def source_dir(family = default_family)
      File.join(family_dir(family), 'source')
    end

    def releases_file
      File.join(base, 'releases.json')
    end

    # A tolerant read: a missing, partial or corrupt registry must never take
    # the public pages down. Returns nil only when there is no usable file.
    def read_states
      raw = JSON.parse(File.read(releases_file))
      entries = raw.is_a?(Hash) ? raw['releases'] : raw
      return nil unless entries.is_a?(Array)

      entries.each_with_object({}) do |entry, states|
        next unless entry.is_a?(Hash)
        release = entry['release'].to_s
        next unless FAMILY.match?(release)

        states[release] = entry.slice('state', 'revision', 'documents', 'publishedAt', 'archivedAt')
      end
    rescue Errno::ENOENT, JSON::ParserError, TypeError
      nil
    end

    def write_states(states)
      payload = { 'releases' => states.map { |release, state| { 'release' => release }.merge(state) } }
      FileUtils.mkdir_p(base)
      temporary = File.join(base, ".releases-#{Process.pid}-#{Thread.current.object_id}.json")
      File.write(temporary, JSON.pretty_generate(payload) + "\n")
      File.rename(temporary, releases_file)
    ensure
      FileUtils.rm_f(temporary) if temporary
    end

    # Published registry rows for the public API. A missing state file is an
    # explicit empty list, not an error.
    def listing
      states = read_states
      return { 'releases' => [], 'default' => default_family } if states.nil?

      rows = families.map do |family|
        state = states[family] || {}
        {
          'release' => family,
          'default' => family == default_family,
          'state' => state['state'] || 'current',
          'revision' => state['revision'],
          'documents' => state['documents'],
          'publishedAt' => state['publishedAt'],
          'archivedAt' => state['archivedAt']
        }
      end
      { 'releases' => rows, 'default' => default_family }
    end

    # Picker rows for the UI: the registry is authoritative even before the
    # worker has written any state.
    def picker
      states = read_states || {}
      families.map do |family|
        state = states[family] || {}
        { 'release' => family, 'default' => family == default_family, 'state' => state['state'] || 'current' }
      end
    end
  end
end
