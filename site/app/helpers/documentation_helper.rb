require 'rdoc'
require 'rdoc/markdown'
module DocumentationHelper
  def documentation_summary_highlight(text, query)
    terms = query.to_s.scan(/[[:alnum:]_]+/).first(20)
    return text if terms.empty?
    pattern = Regexp.new("\\b(?:#{Regexp.union(terms).source})\\b", Regexp::IGNORECASE)
    highlight(text, pattern)
  end
  def documentation_category(doc)
    (doc['category'].presence || doc['bundle'].presence || doc['path'].to_s.split('/').first.to_s.tr('-', ' ').humanize).sub(/\AApi /, 'API ')
  end
  def documentation_snippet(text)
    text.to_s.gsub(/\\([_()\[\]*])/, '\\1')
      .gsub(/\[([^\]]+)\]\([^)]*\)/, '\\1')
      .gsub(/[#*`|]/, '').gsub(/\s+/, ' ').strip
  end
  def documentation_timestamp(value)
    Time.iso8601(value).utc.strftime('%b %-d, %Y at %H:%M UTC')
  rescue ArgumentError, TypeError
    'not yet published'
  end
  def documentation_markdown(body)
    document = RDoc::Markdown.parse(body)
    html = document.accept(RDoc::Markup::ToHtml.new)
    sanitize(html)
  end
end
