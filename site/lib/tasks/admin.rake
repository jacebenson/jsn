namespace :admin do
  desc 'Create an administrator interactively (no public signup)'
  task create: :environment do
    require 'io/console'
    print 'Email: '
    email = $stdin.gets&.strip
    print 'Password (minimum 8 characters): '
    password = $stdin.noecho(&:gets)&.chomp
    puts
    User.create!(email: email, password: password, admin: true)
    puts 'Administrator created.'
  end
end
