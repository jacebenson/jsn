class DocsBuild < ApplicationRecord
  validates :revision, format: { with: /\A[a-f0-9]{7,64}\z/ }
  validates :state, inclusion: { in: %w[building failed published] }
  def self.promote!(revision, manifest)
    validate_manifest!(revision, manifest)
    transaction do
      update_all(active: false)
      build = find_or_initialize_by(revision: revision)
      build.update!(state: 'published', manifest: manifest, active: true)
    end
  end
  def self.validate_manifest!(revision, manifest)
    valid = manifest.is_a?(Hash) && manifest['format'] == 1 && manifest['schema'] == 1 &&
      manifest['cliCompatibility'] == 'docs-schema-1' && manifest['revision'] == revision &&
      manifest['sha256'].to_s.match?(/\A[a-f0-9]{64}\z/)
    %w[compressedBytes databaseBytes].each { |key| valid &&= manifest[key].is_a?(Integer) && manifest[key].positive? }
    url = URI.parse(manifest.fetch('url', '')) rescue nil
    allowed = ENV.fetch('DOCS_ARTIFACT_HOSTS', 'github.com').split(',')
    valid &&= url&.scheme == 'https' && allowed.include?(url.host) && !url.userinfo
    raise ArgumentError, 'Invalid or incompatible snapshot manifest' unless valid
  end
end
