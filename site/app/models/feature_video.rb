class FeatureVideo < ApplicationRecord
  YOUTUBE_HOSTS = %w[youtube.com www.youtube.com m.youtube.com youtu.be www.youtu.be].freeze
  URL_HELP = 'Use a full HTTPS YouTube watch, shorts, embed or youtu.be URL, a JoomDeck /r/slug, /video or /embed URL, an MP4/WebM URL, or another watch-page link.'.freeze

  validates :slug, uniqueness: true, inclusion: { in: ->(_) { ['introduction'] + Feature.all.map { |f| f['canonicalSlug'] } } }
  validates :url, length: { maximum: 2048 }
  validate :https_url

  def provider
    uri = video_uri
    return :link unless uri
    return :youtube if youtube_id(uri)
    return :joomdeck if joomdeck_id(uri)
    return :file if uri.path.match?(/\.(mp4|webm)\z/i)

    :link
  end

  def provider_id
    uri = video_uri
    youtube_id(uri) || joomdeck_id(uri) if uri
  end

  def start_seconds
    uri = video_uri
    return 0 unless uri && youtube_id(uri)

    params = URI.decode_www_form(uri.query.to_s).to_h
    offset = params['start'] || params['t']
    return offset.to_i if offset&.match?(/\A\d+\z/)

    match = offset.to_s.match(/\A(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\z/)
    match ? match[1].to_i * 3600 + match[2].to_i * 60 + match[3].to_i : 0
  end

  def embed_url
    case provider
    when :youtube
      params = { rel: 0, playsinline: 1 }
      params[:start] = start_seconds if start_seconds.positive?
      "https://www.youtube-nocookie.com/embed/#{provider_id}?#{URI.encode_www_form(params)}"
    when :joomdeck
      "https://joomdeck.com/r/#{provider_id}/embed"
    end
  end

  def provider_label
    case provider
    when :youtube then "YouTube - #{provider_id}"
    when :joomdeck then "JoomDeck - #{provider_id}"
    when :file then video_uri.path.match?(/\.mp4\z/i) ? 'MP4 file' : 'WebM file'
    else 'External link'
    end
  end

  private

  def video_uri
    uri = URI.parse(url.to_s)
    uri if uri.is_a?(URI::HTTPS) && uri.host.present? && uri.userinfo.nil?
  rescue URI::InvalidURIError
    nil
  end

  def youtube_id(uri)
    return unless YOUTUBE_HOSTS.include?(uri.host.downcase)

    id = if %w[youtu.be www.youtu.be].include?(uri.host.downcase)
      uri.path.match(%r{\A/([A-Za-z0-9_-]{11})/?\z})&.[](1)
    elsif uri.path == '/watch'
      URI.decode_www_form(uri.query.to_s).to_h['v']
    else
      uri.path.match(%r{\A/(?:embed|shorts)/([A-Za-z0-9_-]{11})/?\z})&.[](1)
    end
    id if id&.match?(/\A[A-Za-z0-9_-]{11}\z/)
  end

  def joomdeck_id(uri)
    return unless uri.host.downcase == 'joomdeck.com'

    uri.path.match(%r{\A/r/([A-Za-z0-9_-]+)(?:/(?:video|embed))?/?\z})&.[](1)
  end

  def https_url
    errors.add(:url, URL_HELP) unless video_uri
  end
end
