class SnapshotsController < ApplicationController
  rescue_from DocsStorage::InvalidIdentity, with: -> { head :service_unavailable }
  def show
    family = selected_release
    return head :not_found unless family
    manifest = published_manifest(family)
    return render json: { error: 'No published documentation snapshot' }, status: :service_unavailable unless manifest
    expires_in 5.minutes, public: true
    render json: manifest
  end

  def download
    family = selected_release
    return head :not_found unless family
    manifest = published_manifest(family)
    return head :service_unavailable unless manifest
    redirect_to manifest.fetch('url'), allow_other_host: true
  end

  def artifact
    family = selected_release
    return head :not_found unless family
    filename = params[:filename].to_s
    return head :not_found unless /\Adocs-[a-f0-9]{7,64}-[a-f0-9]{64}\.sqlite\.gz\z/.match?(filename)
    file = File.join(DocsStorage.snapshots_dir(family), filename)
    snapshots = DocsStorage.snapshots_dir(family)
    return head :not_found unless File.lstat(snapshots).directory?
    directory = File.realpath(snapshots)
    return head :not_found unless File.lstat(file).file? && File.realpath(file) == File.join(directory, filename)
    expires_in 1.year, public: true, immutable: true
    send_file file, type: 'application/gzip', disposition: 'attachment'
  rescue Errno::ENOENT, Errno::ENOTDIR, Errno::ELOOP
    head :not_found
  end

  private

  # Both legacy routes and /docs-index/releases/:release routes land here.
  # An unknown family is a 404, never a 500 and never a fallback corpus.
  def selected_release
    raw = params[:release]
    return DocsStorage.default_family if raw.blank?
    DocsStorage.valid?(raw.to_s) ? raw.to_s : nil
  end

  def published_manifest(family)
    if (manifest = file_manifest(family))
      return nil unless manifest.is_a?(Hash)
      DocsStorage.validate_identity!(manifest['release'], family)
      manifest = manifest.merge('release' => family)
      manifest['url'] = local_artifact_url(manifest, family) if manifest['url'].present?
      return manifest
    end
    manifest = promoted_manifest(family)
    return unless manifest
    DocsStorage.validate_identity!(manifest['release'], family)
    manifest.merge('release' => family)
  end

  def file_manifest(family)
    file = DocsStorage.manifest_path(family)
    return nil unless File.file?(file)
    value = JSON.parse(File.read(file))
    raise DocsStorage::InvalidIdentity, 'Unreadable snapshot metadata.' unless value.is_a?(Hash)
    value
  rescue JSON::ParserError
    raise DocsStorage::InvalidIdentity, 'Unreadable snapshot metadata.'
  rescue Errno::ENOENT
    nil
  end

  def promoted_manifest(family)
    build = DocsBuild.where(active: true, state: 'published', release: family).first
    build ||= DocsBuild.where(active: true, state: 'published', release: nil).first if family == DocsStorage::DEFAULT_FAMILY
    build&.manifest
  end

  # Use this deployment's origin when it is a self-hosted mirror.
  def local_artifact_url(manifest, family)
    name = File.basename(manifest['url'])
    prefix = params[:release].present? ? "releases/#{family}/" : ''
    "#{request.base_url}/docs-index/#{prefix}artifacts/#{name}"
  end
end
