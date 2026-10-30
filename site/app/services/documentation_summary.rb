# Derived presentation metadata. Never replaces the stored document body.
class DocumentationSummary
  def self.build(row)
    metadata = JSON.parse(row.delete('frontmatter').to_s)
    metadata = {} unless metadata.is_a?(Hash)
    description = metadata['description']
    description = nil unless description.is_a?(String)
    description = plain(description.to_s)
    excerpt = first_paragraph(row.delete('preview').to_s)
    summary = description.presence || excerpt.presence || "Read #{row['title'].presence || 'this reference'} in the ServiceNow documentation."
    row['summary'] = shorten(summary, 280)
    row['summary_source'] = description.present? ? 'description' : (excerpt.present? ? 'paragraph' : 'fallback')
    product = metadata['product']
    if product.is_a?(String) && product.present?
      row['category'] = plain(product)
    else
      classification = metadata['classification']
      category = classification.is_a?(String) && classification.present? ? classification : row['path'].to_s.split('/').first
      row['category'] = plain(category.to_s.tr('-', ' ')).humanize.sub(/\AApi /, 'API ')
    end
    row['doc_type'] ||= metadata['topic_type']
    row
  rescue JSON::ParserError
    row['frontmatter'] = '{}'
    build(row)
  end
  def self.plain(value)
    text = value.gsub(/!\[([^\]]*)\]\([^)]*\)/, '\\1').gsub(/\[([^\]]+)\]\([^)]*\)/, '\\1')
      .gsub(/\\([[:punct:]])/, '\\1').gsub(/[`*#]/, '')
    ActionController::Base.helpers.strip_tags(text).gsub(/\s+/, ' ').strip
  end
  def self.first_paragraph(body)
    fenced = false
    paragraphs = []
    current = []
    body.each_line do |line|
      if line.match?(/^ {0,3}(?:`{3,}|~{3,})/)
        fenced = !fenced
        next
      end
      next if fenced || line.match?(/^(?: {4}|\t)/)
      if line.strip.empty?
        paragraphs << current.join(' ') unless current.empty?
        current = []
      elsif line.match?(/^\s*(?:\||\#{1,6}\s|<|[-*+]\s|\d+\.\s)/) || line.match?(/\A\s*\*?\*?Parent Topic:/i)
        next
      else
        current << line.strip
      end
    end
    paragraphs << current.join(' ') unless current.empty?
    plain(paragraphs.find { |paragraph| paragraph.length > 30 }.to_s)
  end
  def self.shorten(text, length)
    return text if text.length <= length
    complete = text[0, length].match(/\A(.{60,}[.!?])(?:\s|\z)/)
    return complete[1] if complete
    text[0, length - 1].sub(/\s+\S*\z/, '') + '…'
  end
end
