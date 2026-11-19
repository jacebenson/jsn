require 'digest'
require 'json'
require 'uri'
require 'time'

# File-backed, read-only projection. Unknown additive record fields are retained.
class SubscriptionScheduleCatalog
  class Invalid < StandardError; end
  attr_reader :schedules, :revision, :bytes, :sha256, :published_at

  def initialize(root: Rails.root.join('config/subscription-schedules'))
    inventory = JSON.parse(root.join('public-inventory.json').read)
    itom = JSON.parse(root.join('itom-2026-04-09.json').read)
    raise Invalid unless inventory.is_a?(Array) && itom.is_a?(Hash)
    @schedules = (inventory + [itom]).sort_by { |r| r.fetch('id') }
    ids = schedules.map { |r| r.fetch('id') }
    raise Invalid unless ids.uniq == ids && schedules.all? { |r| valid_record?(r) }
    @revision = Digest::SHA256.hexdigest(JSON.generate(schedules))
    @bytes = JSON.generate(schema_version: 1, revision: revision, schedules: schedules) + "\n"
    @sha256 = Digest::SHA256.hexdigest(bytes)
    @published_at = schedules.map { |r| Time.iso8601(r['retrieved_at'] || r.fetch('fetched_at')) }.max.iso8601
  rescue JSON::ParserError, URI::InvalidURIError, KeyError, TypeError, ArgumentError, NoMethodError, SystemCallError
    raise Invalid, 'Schedule catalog unavailable'
  end

  def self.label(record)
    record['title'] || "#{record['product']} subscription unit overview"
  end

  def self.version(record)
    record['source_version'] || record['effective_date'] || record['effective_for_skus_introduced'] || 'Effective date not normalized'
  end

  private

  def valid_record?(record)
    return false unless record['id'].is_a?(String) && record['id'].match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/)
    return false unless record['product'].is_a?(String) && record['product'].present?
    %w[title source_version effective_date effective_for_skus_introduced normalization_status].each do |key|
      return false unless record[key].nil? || record[key].is_a?(String)
    end
    if record.key?('categories')
      return false unless record['categories'].is_a?(Array) && record['categories'].all? do |category|
        category.is_a?(Hash) && category['id'].is_a?(String) &&
          category['resources_per_su'].is_a?(Numeric) && category['resources_per_su'].positive? &&
          category['classes'].is_a?(Array) && category['classes'].all? { |name| name.is_a?(String) }
      end
    end
    uri = URI.parse(record.fetch('source_url'))
    uri.scheme == 'https' && uri.host == 'www.servicenow.com' && uri.userinfo.nil? && uri.path.end_with?('.pdf')
  end
end
