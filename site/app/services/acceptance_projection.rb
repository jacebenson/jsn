# Closed public projection for acceptance results. Only allowlisted fields are
# accepted; no hostnames, sys_ids, usernames, free-form errors or raw payloads.
class AcceptanceProjection
  class Invalid < StandardError; end

  SCHEMA_VERSION = 1
  MAX_RESULTS = 5000
  MAX_DURATION_MS = 86_400_000

  STATUSES = %w[
    passed failed failed-timeout blocked-prerequisite blocked-access
    blocked-capability excluded-mode not-run
  ].freeze
  COVERAGE = %w[not-run failed blocked passed complete incomplete].freeze
  COLLECTORS = %w[
    platform_health transactions error_warning_summary event_queue ecc_queue
    flow_executions record_counts scheduled_and_cleanup
  ].freeze
  COLLECTOR_STATUS = %w[
    success timeout permission_denied unsupported unavailable query_failure
  ].freeze
  ID = /\A(?:local|readonly|resources|workflows|auth)\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){0,5}\z/
  FORBIDDEN_SEGMENTS = %w[com net org io dev internal service-now test invalid example localhost].freeze
  SCENARIO_IDS = File.readlines(Rails.root.join('config/acceptance_scenario_ids.txt'), chomp: true).reject(&:empty?).freeze
  RUN_KEY = /\Aacceptance_[a-f0-9]{32}\z/
  SHA40 = /\A[a-f0-9]{40}\z/i
  SHA64 = /\A[a-f0-9]{64}\z/i
  VERSION = /\A\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-z0-9]{1,20})?\z/
  NODE = /\Av\d{1,5}\.\d{1,5}\.\d{1,5}\z/
  DOMAIN_SOURCE = 'bounded Table API domain read via selected profile'

  attr_reader :payload

  def self.parse(raw)
    data = JSON.parse(raw)
    new(data).tap(&:validate!)
  rescue JSON::ParserError
    raise Invalid, 'invalid payload'
  end

  def initialize(payload)
    @payload = payload
  end

  def validate!
    integral!(payload, %w[schemaVersion runKey mode provenance platform environment selection summary performance results], 'projection')
    invalid! unless payload['schemaVersion'] == SCHEMA_VERSION
    invalid! unless RUN_KEY.match?(payload['runKey'].to_s)
    invalid! unless %w[readonly pdi].include?(payload['mode'])
    validate_provenance!
    invalid! unless payload['platform'] == 'linux'
    validate_environment!
    validate_selection!
    validate_summary!
    validate_performance!
    validate_results!
    self
  end

  def results = payload['results']
  def counts = results.group_by { |result| result['status'] }.transform_values(&:length)
  def run_key = payload['runKey']
  def mode = payload['mode']
  def provenance = payload['provenance']
  def selection = payload['selection']
  def summary = payload['summary']
  def performance = payload['performance']

  def duration_ms = results.sum { |result| result['durationMs'] }.round
  def passed = counts.fetch('passed', 0)
  def failed = counts.fetch('failed', 0) + counts.fetch('failed-timeout', 0)
  def blocked = %w[blocked-prerequisite blocked-access blocked-capability].sum { |status| counts.fetch(status, 0) }
  def excluded = counts.fetch('excluded-mode', 0)
  def not_run = counts.fetch('not-run', 0)

  def canonical_digest
    Digest::SHA256.hexdigest(JSON.generate(canonical(payload)))
  end

  private

  def invalid!
    raise Invalid, 'invalid payload'
  end

  def integral!(value, keys, label)
    invalid! unless value.is_a?(Hash) && value.keys.sort == keys.sort
    keys.each { |key| invalid! unless value.key?(key) }
    yield if block_given?
  end

  def integer!(value, min, max)
    invalid! unless value.is_a?(Integer) && value.between?(min, max)
  end

  def number!(value, min, max)
    invalid! unless value.is_a?(Numeric) && value.finite? && value >= min && value <= max
  end

  def safe_id?(value)
    return false unless value.is_a?(String) && value.length <= 100 && ID.match?(value)
    return false unless SCENARIO_IDS.include?(value)
    segments = value.split('.')
    return false if segments.any? { |segment| FORBIDDEN_SEGMENTS.include?(segment) || segment.match?(/\A[a-f0-9]{32}\z/i) || segment.match?(/\A[a-f0-9]{64}\z/i) }
    true
  end

  def validate_provenance!
    provenance = payload['provenance']
    integral!(provenance, %w[sourceSHA version node binarySHA256 sourceDirty], 'provenance')
    invalid! unless SHA40.match?(provenance['sourceSHA'].to_s)
    invalid! unless SHA64.match?(provenance['binarySHA256'].to_s)
    invalid! unless VERSION.match?(provenance['version'].to_s)
    invalid! unless NODE.match?(provenance['node'].to_s)
    invalid! unless [true, false].include?(provenance['sourceDirty'])
  end

  def validate_environment!
    environment = payload['environment']
    integral!(environment, %w[domainSeparation], 'environment')
    invalid! unless %w[UNKNOWN KNOWN NOT-INSTALLED].include?(environment['domainSeparation'])
  end

  def validate_selection!
    selection = payload['selection']
    integral!(selection, %w[full selected], 'selection')
    invalid! unless [true, false].include?(selection['full'])
    invalid! unless selection['selected'].is_a?(Array) && selection['selected'].length <= MAX_RESULTS
    invalid! unless selection['selected'].all? { |id| safe_id?(id) }
    invalid! unless selection['selected'].uniq.length == selection['selected'].length
  end

  def validate_summary!
    summary = payload['summary']
    integral!(summary, %w[total counts complete missingCount], 'summary')
    integer!(summary['total'], 0, MAX_RESULTS)
    integer!(summary['missingCount'], 0, 1_000_000)
    invalid! unless [true, false].include?(summary['complete'])
    counts = summary['counts']
    invalid! unless counts.is_a?(Hash)
    counts.each do |status, count|
      invalid! unless STATUSES.include?(status)
      integer!(count, 0, MAX_RESULTS)
    end
  end

  def validate_performance!
    performance = payload['performance']
    return if performance.nil?
    integral!(performance, %w[observational releaseGate coverage before after environment], 'performance')
    invalid! unless performance['observational'] == true && performance['releaseGate'] == false
    coverage = performance['coverage']
    integral!(coverage, %w[before after compare list], 'performance coverage')
    invalid! unless coverage.values.all? { |value| COVERAGE.include?(value) }
    validate_capture!(performance['before'])
    validate_capture!(performance['after'])
    environment = performance['environment']
    integral!(environment, %w[platform domainSeparation domainTable domainSource effectiveAuth effectiveRoles effectiveDomain], 'performance environment')
    invalid! unless %w[linux untested].include?(environment['platform'])
    invalid! unless %w[not-installed unknown].include?(environment['domainSeparation'])
    invalid! unless %w[readable absent unknown].include?(environment['domainTable'])
    invalid! unless environment['domainSource'] == DOMAIN_SOURCE
    %w[effectiveAuth effectiveRoles effectiveDomain].each { |key| invalid! unless environment[key] == 'unknown' }
  end

  def validate_capture!(capture)
    return if capture.nil?
    integral!(capture, %w[status collectors], 'performance capture')
    invalid! unless %w[complete incomplete].include?(capture['status'])
    collectors = capture['collectors']
    invalid! unless collectors.is_a?(Array) && collectors.length <= COLLECTORS.length
    names = []
    collectors.each do |collector|
      integral!(collector, %w[name status], 'performance collector')
      invalid! unless COLLECTORS.include?(collector['name']) && COLLECTOR_STATUS.include?(collector['status'])
      names << collector['name']
    end
    invalid! unless names.uniq.length == names.length
  end

  def validate_results!
    results = payload['results']
    invalid! unless results.is_a?(Array) && results.length.between?(1, MAX_RESULTS)
    seen = []
    results.each do |result|
      integral!(result, %w[id status durationMs], 'result')
      invalid! unless safe_id?(result['id'])
      invalid! unless STATUSES.include?(result['status'])
      number!(result['durationMs'], 0, MAX_DURATION_MS)
      seen << result['id']
    end
    invalid! unless seen.uniq.length == seen.length

    declared = summary['counts']
    observed = counts
    declared.each { |status, count| invalid! unless count == observed.fetch(status, 0) }
    observed.each { |status, count| invalid! unless declared.fetch(status, 0) == count }
    invalid! unless summary['total'] == results.length
    complete = summary['missingCount'].zero? && results.all? { |result| result['status'] == 'passed' }
    invalid! unless summary['complete'] == complete
  end

  def canonical(value)
    case value
    when Hash then value.keys.sort.to_h { |key| [key, canonical(value[key])] }
    when Array then value.map { |entry| canonical(entry) }
    else value
    end
  end
end
