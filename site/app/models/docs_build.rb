class DocsBuild < ApplicationRecord
  validates :revision, format: { with: /\A[a-f0-9]{7,64}\z/ }
  validates :state, inclusion: { in: %w[building failed published] }
  validates :release, format: { with: DocsStorage::FAMILY }, allow_nil: true

  # Publish a family's manifest without touching any other family's active row.
  def self.promote!(release, revision, manifest)
    validate_manifest!(release, revision, manifest)
    transaction do
      previous = where(release: release)
      # Rows written before the release column belong to legacy Australia.
      previous = previous.or(where(release: nil)) if release == DocsStorage::DEFAULT_FAMILY
      previous.update_all(active: false)
      build = find_by(release: release, revision: revision)
      build ||= find_by(release: nil, revision: revision) if release == DocsStorage::DEFAULT_FAMILY
      build ||= new(revision: revision)
      build.update!(release: release, state: 'published', manifest: manifest, active: true)
    end
  end

  def self.validate_manifest!(release, revision, manifest)
    valid = manifest.is_a?(Hash) && manifest['format'] == 1 && manifest['schema'] == 1 &&
      manifest['cliCompatibility'] == 'docs-schema-1' && manifest['revision'] == revision &&
      manifest['release'] == release && DocsStorage::FAMILY.match?(release.to_s) &&
      manifest['sha256'].to_s.match?(/\A[a-f0-9]{64}\z/)
    %w[compressedBytes databaseBytes].each { |key| valid &&= manifest[key].is_a?(Integer) && manifest[key].positive? }
    url = URI.parse(manifest.fetch('url', '')) rescue nil
    allowed = ENV.fetch('DOCS_ARTIFACT_HOSTS', 'github.com').split(',')
    valid &&= url&.scheme == 'https' && allowed.include?(url.host) && !url.userinfo
    raise ArgumentError, 'Invalid or incompatible snapshot manifest' unless valid
  end
end
