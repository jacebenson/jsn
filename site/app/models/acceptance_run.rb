class AcceptanceRun < ApplicationRecord
  has_many :acceptance_checks, dependent: :delete_all

  def public_metadata
    JSON.parse(local_metadata.presence || '{}')
  rescue JSON::ParserError
    {}
  end

  def measurement_context = public_metadata['measurementContext'] || {}
  def target_label = public_metadata.dig('provenance', 'target') || 'unknown'
  def taskset_version = measurement_context['tasksetVersion'] || 'unknown'
  def cleanup_state = measurement_context['cleanupState'] || 'unknown'

  # Selected-task correctness is independent of static product obligations.
  def selected_verdict
    return 'failed' if failed.positive?
    return 'blocked' if blocked.positive?
    return 'passed' if selected_count.positive? && passed == selected_count && not_run.zero?
    'not-run'
  end

  def comparison_key
    context = measurement_context
    release = public_metadata['release'] || {}
    return nil unless selected_verdict == 'passed' && duration_ms.positive? && !source_dirty
    return nil unless context['suiteSHA256'] && context['environmentSHA256'] && context['environmentLabel'] && taskset_version != 'unknown' && target_label != 'unknown'
    return nil unless context['environmentLabel'] == 'offline-fixture' || (release['family'] && release['build'])
    [context['suiteSHA256'], context['environmentSHA256'], taskset_version, mode, target_label, context['environmentLabel'],
     release.values_at('family', 'build', 'version', 'patch', 'hotfix'), platform, node_version,
     domain_separation, public_metadata.dig('provenance', 'harnessSHA'),
     acceptance_checks.order(:check_id).pluck(:check_id)]
  end
end
