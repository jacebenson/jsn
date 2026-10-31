class FeatureVideo < ApplicationRecord
  validates :slug, uniqueness: true, inclusion: { in: ->(_) { ['introduction'] + Feature.all.map { |f| f['canonicalSlug'] } } }
  validates :url, length: { maximum: 2048 }
  validate :https_url
  private
  def https_url
    uri = URI.parse(url.to_s)
    errors.add(:url, 'must be an HTTPS URL') unless uri.is_a?(URI::HTTPS) && uri.host.present? && uri.userinfo.nil?
  rescue URI::InvalidURIError
    errors.add(:url, 'must be an HTTPS URL')
  end
end
