ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'

class AcceptanceResultsTest < Minitest::Test
  include Rack::Test::Methods

  TOKEN = 'test-ingest-token-that-is-long-enough-123456'

  def app = Rails.application

  def setup
    AcceptanceCheck.delete_all
    AcceptanceRun.delete_all
    @previous_token = ENV['ACCEPTANCE_INGEST_TOKEN']
    ENV['ACCEPTANCE_INGEST_TOKEN'] = TOKEN
    header 'Host', 'www.example.com'
  end

  def teardown
    ENV['ACCEPTANCE_INGEST_TOKEN'] = @previous_token
  end

  def projection(overrides = {})
    {
      'schemaVersion' => 1,
      'runKey' => "acceptance_#{'a' * 32}",
      'mode' => 'readonly',
      'provenance' => {
        'sourceSHA' => 'b' * 40, 'version' => '5.4.0', 'node' => 'v22.11.0',
        'binarySHA256' => 'c' * 64, 'sourceDirty' => false
      },
      'platform' => 'linux',
      'environment' => { 'domainSeparation' => 'UNKNOWN' },
      'selection' => { 'full' => true, 'selected' => %w[readonly.records readonly.catalog.tables.list] },
      'summary' => { 'total' => 2, 'counts' => { 'passed' => 1, 'failed' => 1 }, 'complete' => false, 'missingCount' => 3 },
      'performance' => nil,
      'results' => [
        { 'id' => 'readonly.records', 'status' => 'passed', 'durationMs' => 1200.0 },
        { 'id' => 'readonly.catalog.tables.list', 'status' => 'failed', 'durationMs' => 800.0 }
      ]
    }.merge(overrides)
  end

  def post_projection(payload, token: TOKEN)
    header 'Authorization', "Bearer #{token}" if token
    post '/api/acceptance/runs', payload.to_json, 'CONTENT_TYPE' => 'application/json'
  end

  def test_token_is_required_and_ingestion_fails_closed_when_unconfigured
    ENV['ACCEPTANCE_INGEST_TOKEN'] = nil
    post_projection(projection)
    assert_equal 503, last_response.status
    assert_equal 0, AcceptanceRun.count

    ENV['ACCEPTANCE_INGEST_TOKEN'] = TOKEN
    post_projection(projection, token: 'wrong-token-that-is-also-long-enough-000000')
    assert_equal 401, last_response.status
    assert_equal 0, AcceptanceRun.count
  end

  def test_valid_projection_is_stored_with_derived_counts_and_no_echo
    post_projection(projection)
    assert_equal 201, last_response.status
    body = JSON.parse(last_response.body)
    assert_equal 'accepted', body['status']
    assert_equal 1, AcceptanceRun.count
    run = AcceptanceRun.first
    assert_equal 1, run.passed
    assert_equal 1, run.failed
    assert_equal 0, run.blocked
    assert_equal 2000, run.duration_ms
    assert_equal 2, run.total
    assert_equal 2, run.acceptance_checks.count
    refute_includes last_response.body, 'b' * 40
  end

  def test_duplicate_is_idempotent_and_changed_payload_conflicts
    post_projection(projection)
    assert_equal 201, last_response.status
    post_projection(projection)
    assert_equal 200, last_response.status
    assert_equal 'duplicate', JSON.parse(last_response.body)['status']
    assert_equal 1, AcceptanceRun.count

    changed = projection('results' => [
      { 'id' => 'readonly.records', 'status' => 'passed', 'durationMs' => 1201 },
      { 'id' => 'readonly.catalog.tables.list', 'status' => 'failed', 'durationMs' => 800 }
    ])
    post_projection(changed)
    assert_equal 409, last_response.status
    assert_equal 1, AcceptanceRun.count
  end

  def test_strict_allowlist_rejects_unknown_nested_fields_and_unsafe_values
    post_projection(projection('expectedHost' => 'pdi.example.test'))
    assert_equal 422, last_response.status
    refute_includes last_response.body, 'pdi.example.test'

    post_projection(projection('provenance' => projection['provenance'].merge('host' => 'pdi.example.test')))
    assert_equal 422, last_response.status

    post_projection(projection('performance' => {
      'observational' => true, 'releaseGate' => false,
      'coverage' => { 'before' => 'passed', 'after' => 'passed', 'compare' => 'passed', 'list' => 'passed' },
      'before' => nil, 'after' => nil,
      'environment' => {
        'platform' => 'linux', 'domainSeparation' => 'unknown', 'domainTable' => 'absent',
        'domainSource' => 'pdi.example.test', 'effectiveAuth' => 'unknown',
        'effectiveRoles' => 'unknown', 'effectiveDomain' => 'unknown'
      }
    }))
    assert_equal 422, last_response.status
    assert_equal 0, AcceptanceRun.count
  end

  def test_allowed_fields_cannot_smuggle_hostnames_or_sys_ids
    hostname_like = projection(
      'results' => [
        { 'id' => 'readonly.pdi.example.test', 'status' => 'passed', 'durationMs' => 1 },
        { 'id' => 'readonly.records', 'status' => 'passed', 'durationMs' => 1 }
      ],
      'summary' => { 'total' => 2, 'counts' => { 'passed' => 2 }, 'complete' => false, 'missingCount' => 0 }
    )
    post_projection(hostname_like)
    assert_equal 422, last_response.status

    sys_id_like = projection(
      'results' => [{ 'id' => 'readonly.aabbccddeeff00112233445566778899', 'status' => 'passed', 'durationMs' => 1 }],
      'summary' => { 'total' => 1, 'counts' => { 'passed' => 1 }, 'complete' => false, 'missingCount' => 0 }
    )
    post_projection(sys_id_like)
    assert_equal 422, last_response.status

    post_projection(projection('provenance' => projection['provenance'].merge('version' => '5.4.0-pdi.example.test')))
    assert_equal 422, last_response.status
    post_projection(projection('provenance' => projection['provenance'].merge('version' => '5.4.12345678901234567890123456789012')))
    assert_equal 422, last_response.status
    assert_equal 0, AcceptanceRun.count
  end

  def test_counts_and_completeness_must_match_results
    bad_counts = projection('summary' => { 'total' => 2, 'counts' => { 'passed' => 2 }, 'complete' => false, 'missingCount' => 3 })
    post_projection(bad_counts)
    assert_equal 422, last_response.status

    bad_complete = projection('summary' => { 'total' => 2, 'counts' => { 'passed' => 1, 'failed' => 1 }, 'complete' => true, 'missingCount' => 0 })
    post_projection(bad_complete)
    assert_equal 422, last_response.status

    bad_total = projection('summary' => { 'total' => 3, 'counts' => { 'passed' => 1, 'failed' => 1 }, 'complete' => false, 'missingCount' => 3 })
    post_projection(bad_total)
    assert_equal 422, last_response.status
    assert_equal 0, AcceptanceRun.count
  end

  def test_invalid_statuses_ids_and_oversized_bodies_are_rejected
    post_projection(projection('results' => [{ 'id' => 'readonly.records', 'status' => 'green', 'durationMs' => 1 }]))
    assert_equal 422, last_response.status

    post_projection(projection('results' => [{ 'id' => 'Dev366743', 'status' => 'passed', 'durationMs' => 1 }]))
    assert_equal 422, last_response.status

    header 'Authorization', "Bearer #{TOKEN}"
    post '/api/acceptance/runs', 'a' * 262_145, 'CONTENT_TYPE' => 'application/json'
    assert_equal 422, last_response.status
    assert_equal 0, AcceptanceRun.count
  end

  def test_dashboard_renders_counts_history_timings_and_sanitized_metadata
    payload = projection('performance' => {
      'observational' => true, 'releaseGate' => false,
      'coverage' => { 'before' => 'complete', 'after' => 'complete', 'compare' => 'passed', 'list' => 'passed' },
      'before' => { 'status' => 'complete', 'collectors' => [{ 'name' => 'transactions', 'status' => 'success' }] },
      'after' => { 'status' => 'complete', 'collectors' => [{ 'name' => 'transactions', 'status' => 'success' }] },
      'environment' => {
        'platform' => 'linux', 'domainSeparation' => 'unknown', 'domainTable' => 'absent',
        'domainSource' => 'bounded Table API domain read via selected profile', 'effectiveAuth' => 'unknown',
        'effectiveRoles' => 'unknown', 'effectiveDomain' => 'unknown'
      }
    })
    post_projection(payload)
    assert_equal 201, last_response.status

    get '/results'
    assert_equal 200, last_response.status
    assert_includes last_response.body, '1 passed · 1 failed · 0 blocked'
    assert_includes last_response.body, 'Read-only'
    assert_includes last_response.body, '2.0s'
    refute_includes last_response.body, 'pdi.example.test'

    run = AcceptanceRun.first
    get "/results/#{run.run_key}"
    assert_equal 200, last_response.status
    assert_includes last_response.body, 'readonly.catalog.tables.list'
    assert_includes last_response.body, 'failed'
    assert_includes last_response.body, 'partial'
    assert_includes last_response.body, 'before complete'
    refute_includes last_response.body, 'pdi.example.test'

    get '/results/acceptance_ffffffffffffffffffffffffffffffff'
    assert_equal 404, last_response.status
  end

  def test_excluded_and_not_run_statuses_are_grouped
    payload = projection(
      'results' => [
        { 'id' => 'readonly.records', 'status' => 'excluded-mode', 'durationMs' => 1 },
        { 'id' => 'readonly.catalog.tables.list', 'status' => 'not-run', 'durationMs' => 2 }
      ],
      'summary' => { 'total' => 2, 'counts' => { 'excluded-mode' => 1, 'not-run' => 1 }, 'complete' => false, 'missingCount' => 1 }
    )
    post_projection(payload)
    assert_equal 201, last_response.status
    run = AcceptanceRun.first
    assert_equal 1, run.excluded
    assert_equal 1, run.not_run
    assert_equal 0, run.failed
  end
end
