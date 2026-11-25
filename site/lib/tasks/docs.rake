namespace :docs do
  desc 'Fetch GitHub documentation and atomically publish the shared search index'
  task sync: :environment do
    result = DocsSync.new.run
    if result[:locked]
      puts 'A documentation sync is already running.'
      next
    end

    puts JSON.generate(result)
    abort 'Documentation sync failed; the previous index remains available.' unless result[:ok]
  end
end
