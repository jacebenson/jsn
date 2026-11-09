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

  def test_every_declared_scenario_has_a_reviewed_human_name
    helper = Object.new.extend(AcceptanceResultsHelper)
    ids = Rails.root.join('config/acceptance_scenario_ids.txt').read.lines.map(&:strip).reject(&:empty?)
    assert_equal ids.sort, AcceptanceResultsHelper::SCENARIO_NAMES.keys.sort
    ids.each do |id|
      name = helper.acceptance_scenario_name(id)
      refute_equal 'Unrecognized test', name, id
      refute_includes name, id
    end
    assert_equal 'Generate shell tab-completion script', helper.acceptance_scenario_name('local.completion')
    assert_equal 'List UX applicability records', helper.acceptance_scenario_name('readonly.catalog.uxapplicability.list')
    assert_equal 'Show a UX applicability record', helper.acceptance_scenario_name('readonly.catalog.uxapplicability.show')
    assert_equal 'Unrecognized test', helper.acceptance_scenario_name('readonly.catalog.unknown.list')
    assert_equal 'Unrecognized test', helper.acceptance_scenario_name('private payload title')
    assert_equal 'Status unavailable', helper.acceptance_status_explanation('unknown')
  end

  def test_checks_render_human_names_plain_statuses_and_collapsed_technical_ids
    explanations = {
      'passed' => 'Passed: checks completed successfully',
      'failed' => 'Failed: checks did not pass',
      'failed-timeout' => 'Failed: test timed out',
      'blocked-prerequisite' => 'Not run: prerequisite did not complete',
      'blocked-access' => 'Blocked: access was denied',
      'blocked-capability' => 'Blocked: required capability unavailable',
      'excluded-mode' => 'Not run: excluded from this run mode',
      'not-run' => 'Not run: test was not executed'
    }
    ids = %w[local.completion local.version local.history-empty readonly.catalog.uxapplicability.show readonly.records readonly.catalog.uxapplicability.list workflows.context workflows.interactive]
    results = ids.zip(explanations.keys).map { |id, status| { 'id' => id, 'status' => status, 'durationMs' => 1 } }
    post_projection(projection(
      'selection' => { 'full' => false, 'selected' => ids },
      'results' => results,
      'summary' => { 'total' => results.size, 'counts' => explanations.keys.to_h { |status| [status, 1] }, 'complete' => false, 'missingCount' => 1 }
    ))
    assert_equal 201, last_response.status
    get "/results/#{AcceptanceRun.first.run_key}"
    assert_equal 200, last_response.status
    document = Nokogiri::HTML(last_response.body)
    rows = document.css('.results-table tbody tr')
    assert_equal results.size, rows.size
    rows.zip(results.sort_by { |result| result['id'] }).each do |row, result|
      assert_equal AcceptanceResultsHelper::SCENARIO_NAMES.fetch(result['id']), row.at_css('td > strong').text
      details = row.at_css('td > details')
      refute details.key?('open')
      assert_equal 'Technical ID', details.at_css('summary').text
      assert_equal result['id'], details.at_css('code').text
      assert_equal explanations.fetch(result['status']), row.at_css('.badge').text
    end
    assert_equal 2, AcceptanceRun.first.failed
    # A dependent show is not another failure or a claim about the list's cause.
    show_row = rows.find { |row| row.at_css('code').text == 'readonly.catalog.uxapplicability.show' }
    refute_includes show_row.text, 'invalid table'
    assert_empty show_row.css('a')
    assert_equal 1, document.css('.results-checks a').size
    assert_equal 'https://github.com/jacebenson/jsn/issues/435', document.at_css('.results-checks a')['href']
    refute_includes last_response.body, 'pdi.example.test'
    assert_equal '/results', document.at_css('a.back')['href']
  end

  def test_unknown_stored_id_has_an_explicit_fallback_and_expandable_identity
    post_projection(projection)
    assert_equal 201, last_response.status
    run = AcceptanceRun.first
    # Legacy/future stored IDs must not be turned into guessed prose. This does
    # not permit unknown IDs through ingestion.
    run.acceptance_checks.first.update!(check_id: 'future.scenario')
    get "/results/#{run.run_key}"
    assert_equal 200, last_response.status
    document = Nokogiri::HTML(last_response.body)
    row = document.css('.results-checks tbody tr').find { |item| item.at_css('code').text == 'future.scenario' }
    assert_equal 'Unrecognized test', row.at_css('td > strong').text
    refute row.at_css('details').key?('open')
    assert_equal 'Technical ID', row.at_css('summary').text
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
