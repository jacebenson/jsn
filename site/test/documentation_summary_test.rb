ENV['RAILS_ENV'] = 'test'
require_relative '../config/environment'
require 'minitest/autorun'
class DocumentationSummaryTest < Minitest::Test
  def row(metadata: {}, body: '')
    { 'title' => 'Example', 'path' => 'api-reference/example.md', 'frontmatter' => metadata.to_json, 'preview' => body }
  end
  def test_prefers_source_description_and_cleans_inline_markdown
    result = DocumentationSummary.build(row(metadata: { description: 'Use **Flow Designer** to run [flows](https://example.test) with `sys_id` values.', product: 'Workflow Studio' }, body: '# Not a summary'))
    assert_equal 'Use Flow Designer to run flows with sys_id values.', result['summary']
    assert_equal 'Workflow Studio', result['category']
    assert_equal 'description', result['summary_source']
  end
  def test_fallback_skips_headings_code_and_tables
    source = "# Title\n\n```js\nvar unsafe = 'not prose';\n```\n\n|Name|Type|\n|---|---|\n|id|String|\n\nThis useful paragraph explains the feature without leaking Markdown syntax."
    result = DocumentationSummary.build(row(body: source))
    assert_equal 'This useful paragraph explains the feature without leaking Markdown syntax.', result['summary']
    assert_equal 'paragraph', result['summary_source']
    assert_equal 'API reference', result['category']
  end
  def test_long_malformed_or_missing_metadata_stays_readable
    result = DocumentationSummary.build(row(metadata: { description: 'word ' * 100 }))
    assert_operator result['summary'].length, :<=, 280
    assert result['summary'].end_with?('…')
    input = row(body: 'A useful paragraph remains available when source metadata is malformed.')
    input['frontmatter'] = 'not-json'
    assert_equal 'paragraph', DocumentationSummary.build(input)['summary_source']
    assert_equal 'fallback', DocumentationSummary.build(row)['summary_source']
  end
end
