ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
require 'rack/test'

class SnbenchTest < Minitest::Test
  include Rack::Test::Methods
  def app = Rails.application

  def setup
    SnbenchAttempt.delete_all
    SnbenchRun.delete_all
    header 'Host', 'www.example.com'
  end

  def fixtures
    Dir[Rails.root.join('test/fixtures/snbench/*.json')].sort.map { |file| JSON.parse(File.read(file)) }
  end

  def test_ingest_is_idempotent_and_conflicts_do_not_replace_snapshots
    payload = fixtures.first
    2.times { SnbenchRun.ingest(payload) }
    assert_equal 1, SnbenchRun.count
    assert_equal payload['attempts'].size, SnbenchAttempt.count
    assert_raises(ArgumentError) { SnbenchRun.ingest(payload.merge('tool_version' => 'changed')) }
    assert_nil SnbenchRun.first.tool_version
  end

  def test_attempts_are_averaged_within_task_before_tasks
    payload = fixtures.first.deep_dup
    a = payload['attempts'].first
    payload['attempts'] = [a.merge('task' => 'a', 'attempt' => 1, 'pass' => true),
      a.merge('task' => 'a', 'attempt' => 2, 'pass' => false),
      a.merge('task' => 'a', 'attempt' => 3, 'pass' => false),
      a.merge('task' => 'b', 'attempt' => 1, 'pass' => true)]
    run = SnbenchRun.ingest(payload)
    summary = SnbenchSummary.new(run.snbench_attempts.to_a)
    assert_in_delta 2.0 / 3, summary.mean(:pass)
    assert_in_delta 4.0 / 3, summary.passed
    assert_equal 2, summary.attempted
    get "/snbench/#{run.run_id}"
    assert_equal 200, last_response.status
    assert_includes last_response.body, '66.7%'
  end

  def test_real_fixture_pages_and_filters
    fixtures.each { |payload| SnbenchRun.ingest(payload) }
    get '/snbench'
    assert_equal 200, last_response.status
    assert_includes last_response.body, '88.2%'
    assert_includes last_response.body, '100.0%'
    assert_includes last_response.body, '0.0%'
    assert_includes last_response.body, '5 runs, 71 attempts, 34 distinct tasks'
    get '/snbench', track: 'agent', model: 'hermes-local/Qwen3.8-27B-UD-Q4_K_M', tool: 'jsn'
    assert_equal 200, last_response.status
    assert_includes last_response.body, '88.2%'
    refute_includes last_response.body, '/snbench/fixture-nop'
    refute_includes last_response.body, '/snbench/2026-11-23-cpsd'
    get '/snbench/2026-11-23-aamb'
    assert_equal 200, last_response.status
    assert_includes last_response.body, '0.0%'
    run = SnbenchRun.find_by!(run_id: '2026-11-23-aamb')
    failing = run.snbench_attempts.first.checks.find { |c| !c['ok'] }
    assert_includes last_response.body, ERB::Util.html_escape(failing['what'])
    get '/snbench/missing'
    assert_equal 404, last_response.status
    get '/snbench', tool: 'unknown'
    assert_includes last_response.body, 'No benchmark runs match'
  end

  def test_matrix_always_shows_inventory_and_task_metrics
    SnbenchRun.ingest(fixtures.find { |p| p['run_id'] == '2026-11-23-aamb' })
    get '/snbench', track: 'agent'
    assert_equal 200, last_response.status
    doc = Nokogiri::HTML(last_response.body)
    rows = doc.css('.snbench-matrix tbody tr')
    assert_equal 34, rows.size
    assert_equal SnbenchCatalog.tasks.map { |t| t['id'] }, rows.map { |r| r['data-task-id'] }
    query = rows.find { |r| r['data-task-id'] == 'query-filtered' }
    assert_includes query.text, '0/1 (0.0%) · partial'
    assert_includes query.text, 'Mean USD 0.001009'
    assert_includes query.text, 'mean seconds 44.7'
    assert_includes query.text, '4727.0 / 364.0'
    assert_equal '-', rows.find { |r| r['data-task-id'] == 'app-install' }.css('td').first.text.strip
    assert_includes doc.at_css('tfoot').text, '0.0 / 1 tasks'
    get '/snbench/2026-11-23-aamb'
    assert_includes last_response.body, '0 attempts · partial'
    assert_includes last_response.body, 'shell executions'
    assert_includes last_response.body, 'shell failures'
    assert_includes last_response.body, 'Turns'
  end

  def test_chart_ranking_and_per_task_resource_totals
    payload = fixtures.find { |p| p['run_id'] == '2026-11-23-aamb' }.deep_dup
    original = payload['attempts'].first
    payload['attempts'] = [original, original.merge('attempt' => 2)]
    run = SnbenchRun.ingest(payload)
    entry = SnbenchEntry.new(['agent', 'jsn'], [run])
    assert_in_delta original['cost_usd'] * 2, entry.per_task_total(:cost_usd)
    assert_in_delta original['tokens']['output'] * 2, entry.per_task_total(:output)
    %w[cost_usd output agent_seconds invalid].each do |metric|
      get '/snbench', metric: metric
      assert_equal 200, last_response.status
      doc = Nokogiri::HTML(last_response.body)
      assert_equal 1, doc.css('svg circle').size
      assert_equal ['MODEL / CONFIG', 'PASS@1', 'AVG COST (per task)', 'OUT TOK', 'STEPS'], doc.css('.snbench-ranked th').map(&:text)
      assert_includes doc.at_css('.snbench-ranked').text, '(n=1)'
    end
  end

  def test_invalid_attempt_rolls_back_run
    payload = fixtures.first.deep_dup
    payload['attempts'].first['pass'] = 'false'
    assert_raises(ArgumentError) { SnbenchRun.ingest(payload) }
    assert_equal 0, SnbenchRun.count
    assert_equal 0, SnbenchAttempt.count
  end
end
