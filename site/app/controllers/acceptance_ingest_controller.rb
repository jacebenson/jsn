class AcceptanceIngestController < ApplicationController
  MAX_BYTES = 262_144

  def create
    token = ENV['ACCEPTANCE_INGEST_TOKEN'].to_s
    return render(json: { error: 'unavailable' }, status: :service_unavailable) if token.empty?

    supplied = request.authorization.to_s.delete_prefix('Bearer ')
    return render(json: { error: 'unauthorized' }, status: :unauthorized) unless
      supplied.bytesize == token.bytesize && ActiveSupport::SecurityUtils.secure_compare(supplied, token)

    raw = request.raw_post
    return invalid if request.content_length.to_i > MAX_BYTES || raw.bytesize > MAX_BYTES

    projection = AcceptanceProjection.parse(raw)
    digest = projection.canonical_digest

    existing = AcceptanceRun.find_by(run_key: projection.run_key)
    return existing.payload_digest == digest ? duplicate(projection) : conflict if existing

    run = persist(projection, digest)
    render json: { status: 'accepted', runKey: run.run_key }, status: :created
  rescue AcceptanceProjection::Invalid
    invalid
  rescue ActiveRecord::RecordNotUnique
    existing = AcceptanceRun.find_by(run_key: projection&.run_key)
    existing&.payload_digest == digest ? duplicate(projection) : conflict
  rescue ActiveRecord::RecordInvalid
    invalid
  end

  private

  def persist(projection, digest)
    AcceptanceRun.transaction do
      run = AcceptanceRun.create!(
        run_key: projection.run_key, schema_version: AcceptanceProjection::SCHEMA_VERSION,
        mode: projection.mode, cli_version: projection.provenance['version'],
        source_sha: projection.provenance['sourceSHA'], source_dirty: projection.provenance['sourceDirty'],
        node_version: projection.provenance['node'], binary_sha256: projection.provenance['binarySHA256'],
        platform: projection.payload['platform'], domain_separation: projection.payload['environment']['domainSeparation'],
        selection_full: projection.selection['full'], selected_count: projection.selection['selected'].length,
        total: projection.results.length, passed: projection.passed, failed: projection.failed,
        blocked: projection.blocked, excluded: projection.excluded, not_run: projection.not_run,
        complete: projection.summary['complete'], missing_count: projection.summary['missingCount'],
        duration_ms: projection.duration_ms, payload_digest: digest,
        performance: projection.performance.nil? ? nil : JSON.generate(projection.performance)
      )
      projection.results.each do |result|
        run.acceptance_checks.create!(check_id: result['id'], status: result['status'], duration_ms: result['durationMs'])
      end
      run
    end
  end

  def invalid = render(json: { error: 'invalid payload' }, status: :unprocessable_entity)
  def duplicate(projection) = render(json: { status: 'duplicate', runKey: projection.run_key })
  def conflict = render(json: { error: 'run key conflict' }, status: :conflict)
end
