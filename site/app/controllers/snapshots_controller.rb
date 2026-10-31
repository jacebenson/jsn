class SnapshotsController < ApplicationController
  def show
    manifest = published_manifest
    return render json: { error: 'No published documentation snapshot' }, status: :service_unavailable unless manifest
    expires_in 5.minutes, public: true
    render json: manifest
  end
  def download
    manifest = published_manifest
    return head :service_unavailable unless manifest
    redirect_to manifest.fetch('url'), allow_other_host: true
  end
  def artifact
    filename = params[:filename].to_s
    return head :not_found unless /\Adocs-[a-f0-9]{7,64}-[a-f0-9]{64}\.sqlite\.gz\z/.match?(filename)
    file = File.join(DocumentationIndex.storage, 'snapshots', filename)
    return head :not_found unless File.file?(file)
    expires_in 1.year, public: true, immutable: true
    send_file file, type: 'application/gzip', disposition: 'attachment'
  end
  private
  def published_manifest
    file = File.join(DocumentationIndex.storage, 'snapshots/manifest.json')
    if File.file?(file)
      manifest = JSON.parse(File.read(file))
      # Use this deployment's origin when it is a self-hosted mirror.
      manifest['url'] = "#{request.base_url}/docs-index/artifacts/#{File.basename(manifest.fetch('url'))}"
      return manifest
    end
    DocsBuild.find_by(active: true, state: 'published')&.manifest
  rescue JSON::ParserError, KeyError, Errno::ENOENT
    nil
  end
end
