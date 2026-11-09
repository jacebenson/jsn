require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require 'json'
require 'time'
require 'open3'
require 'rbconfig'

class DocsWorkerTest < Minitest::Test
  WORKER = File.expand_path('../bin/docs-worker', __dir__)
  NOW = Time.utc(2026, 1, 1, 12)

  # Execute the real scheduler for one tick without running Rails or waiting.
  PROBE = <<~'RUBY'
    require 'json'
    require 'time'
    now = Time.iso8601(ARGV.fetch(1))
    Time.define_singleton_method(:now) { now }
    Kernel.module_eval do
      define_method(:system) do |*args, **options|
        puts JSON.generate(command: args, directory: options[:chdir])
        true
      end
      define_method(:sleep) { |_seconds| exit 0 }
    end
    load ARGV.fetch(0)
  RUBY

  {
    'recent failure without a manifest waits an hour' => ['failed', 60, false, false],
    'recent failure with a manifest waits an hour' => ['failed', 60, true, false],
    'expired failure retries without a manifest' => ['failed', 3600, false, true],
    'expired failure retries with a manifest' => ['failed', 3600, true, true],
    'recent successful build keeps its daily interval' => ['ready', 60, true, false],
    'expired successful build syncs again' => ['ready', 86400, true, true],
    'successful status with a missing manifest repairs immediately' => ['ready', 60, false, true],
    'missing status bootstraps immediately' => [nil, 0, false, true],
    'malformed status bootstraps immediately' => ['invalid', 0, false, true]
  }.each do |description, (state, age, manifest, expected)|
    define_method("test_#{description.tr(' ', '_')}") do
      Dir.mktmpdir('jsn-docs-worker-') do |storage|
        if state == 'invalid'
          File.write(File.join(storage, 'status.json'), '{')
        elsif state
          File.write(File.join(storage, 'status.json'), JSON.generate(state: state, checkedAt: (NOW - age).iso8601))
        end
        if manifest
          FileUtils.mkdir_p(File.join(storage, 'snapshots'))
          File.write(File.join(storage, 'snapshots/manifest.json'), '{}')
        end
        stdout, stderr, result = Open3.capture3(
          { 'DOCS_STORAGE_DIR' => storage }, RbConfig.ruby, '-e', PROBE, WORKER, NOW.iso8601
        )
        assert result.success?, stderr
        commands = stdout.lines.map { |line| JSON.parse(line) }
        assert_equal expected ? 1 : 0, commands.length, description
        if expected
          assert_equal [File.expand_path('../bin/rails', __dir__), 'docs:sync'], commands.first.fetch('command')
          assert_equal File.expand_path('..', __dir__), commands.first.fetch('directory')
        end
      end
    end
  end
end
