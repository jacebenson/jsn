namespace :docs do
  desc 'Fetch GitHub documentation and atomically publish the shared search index'
  task sync: :environment do
    require 'fileutils'
    storage = ENV.fetch('DOCS_STORAGE_DIR', Rails.root.join('storage/docs').to_s)
    FileUtils.mkdir_p(storage)
    File.open(File.join(storage, 'sync.lock'), 'a') do |lock|
      unless lock.flock(File::LOCK_EX | File::LOCK_NB)
        puts 'A documentation sync is already running.'
        next
      end
      success = system({ 'DOCS_STORAGE_DIR' => storage, 'JSN_DATA_HOME' => File.join(storage, 'cache') }, ENV.fetch('NODE_BIN', 'node'), Rails.root.join('script/sync-docs.mjs').to_s)
      abort 'Documentation sync failed; the previous index remains available.' unless success
    end
  end
end
