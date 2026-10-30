require 'sqlite3'
class DocumentationIndex
  class Unavailable < StandardError; end
  class InvalidQuery < StandardError; end
  def self.storage = ENV.fetch('DOCS_STORAGE_DIR', Rails.root.join('storage/docs').to_s)
  def self.status
    JSON.parse(File.read(File.join(storage, 'status.json'))).slice('state', 'checkedAt', 'publishedAt', 'documents', 'revision')
  rescue Errno::ENOENT, JSON::ParserError
    { 'state' => 'unavailable' }
  end
  def self.open
    path = File.join(storage, 'docs.sqlite3')
    raise Unavailable, 'Documentation is being prepared. Please try again shortly.' unless File.file?(path)
    db = SQLite3::Database.new(path, readonly: true)
    db.results_as_hash = true
    db.busy_timeout = 2000
    yield new(db)
  rescue SQLite3::Exception
    raise Unavailable, 'Documentation search is temporarily unavailable.'
  ensure
    db&.close
  end
  def initialize(db) = @db = db
  def revision = @db.get_first_value("SELECT value FROM meta WHERE key = 'source_revision'")
  def search(query:, limit: 20, offset: 0, bundle: nil)
    text = query.to_s.strip
    raise InvalidQuery, 'Enter a search of 1 to 200 characters.' unless text.length.between?(1, 200)
    tokens = text.scan(/[[:alnum:]_]+/).first(20)
    raise InvalidQuery, 'Enter a word to search for.' if tokens.empty?
    match = tokens.map { |token| %Q("#{token}") }.join(' AND ')
    limit = Integer(limit.to_s, exception: false)
    offset = Integer(offset.to_s, exception: false)
    raise InvalidQuery, 'Limit must be 1–50 and offset 0–10000.' unless limit&.between?(1, 50) && offset&.between?(0, 10_000)
    filter = bundle.present? ? ' AND d.bundle = ?' : ''
    binds = [match]
    binds << bundle if bundle.present?
    total = @db.get_first_value("SELECT COUNT(*) FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?#{filter}", binds)
    rows = @db.execute(<<~SQL, binds + [text, text, text, limit, offset])
      SELECT d.id, d.path, d.title, d.bundle, d.doc_type, d.release, d.frontmatter,
        substr(d.body, 1, 12000) AS preview,
        snippet(docs_fts, 1, '', '', ' … ', 24) AS snippet
      FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid
      WHERE docs_fts MATCH ?#{filter}
      ORDER BY CASE WHEN lower(d.title) = lower(?) THEN 0
        WHEN instr(lower(d.title), lower(?)) = 1 THEN 1
        WHEN instr(lower(d.title), lower(?)) > 0 THEN 2 ELSE 3 END,
        bm25(docs_fts, 10.0, 1.0), d.id LIMIT ? OFFSET ?
    SQL
    rows = rows.map { |row| DocumentationSummary.build(row.dup) }
    { query: text, revision: revision, total: total, count: rows.length, limit: limit, offset: offset, results: rows }
  end
  def document(id: nil, path: nil)
    row = if path.present?
      @db.get_first_row('SELECT id, path, title, bundle, doc_type, release, body FROM docs WHERE path = ?', [path])
    elsif id.to_s.match?(/\A\d{1,18}\z/)
      @db.get_first_row('SELECT id, path, title, bundle, doc_type, release, body FROM docs WHERE id = ?', [id.to_i])
    end
    raise ActiveRecord::RecordNotFound unless row
    row
  end
end
