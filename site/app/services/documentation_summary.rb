# Compatibility entry point for website callers; summaries share the Node engine.
class DocumentationSummary
  def self.build(row)
    DocumentationIndex.open { |index| index.call('summary', row) }
  end
end
