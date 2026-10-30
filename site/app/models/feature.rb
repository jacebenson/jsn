class Feature
  def self.all
    JSON.parse(File.read(Rails.root.join('config/features.json')))
  end
  def self.find(slug)
    all.find { |feature| feature['canonicalSlug'] == slug } || raise(ActiveRecord::RecordNotFound)
  end
end
