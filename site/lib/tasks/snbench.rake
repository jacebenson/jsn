namespace :snbench do
  desc 'Import immutable snbench JSON snapshots: snbench:import[/path/to/results]'
  task :import, [:directory] => :environment do |_task, args|
    directory = args[:directory].presence || Rails.root.join('test/fixtures/snbench').to_s
    files = Dir[File.join(directory, '*.json')].sort
    abort "No JSON results found in #{directory}" if files.empty?
    files.each { |file| SnbenchRun.ingest(JSON.parse(File.read(file))) }
    puts "Imported #{files.size} files; stored #{SnbenchRun.count} runs, #{SnbenchAttempt.count} attempts."
  end
end
