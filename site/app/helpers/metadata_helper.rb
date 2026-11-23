module MetadataHelper
  def page_title
    if @feature
      "ServiceNow CLI: #{@feature.fetch('title')} · JSN"
    elsif controller_name == 'pages' && action_name == 'index'
      request.path.delete_suffix('/') == '/features' ? 'ServiceNow CLI features and commands · JSN' : 'JSN: ServiceNow CLI for records, scripts and update sets'
    elsif @guide
      "#{@guide.title} · ServiceNow CLI guide · JSN"
    elsif controller_name == 'guides'
      'ServiceNow CLI guides: install, connect and work safely · JSN'
    else
      content_for(:title).presence || 'JSN · ServiceNow CLI'
    end
  end

  def page_description
    text = if @feature
      @feature['tagline']
    elsif @guide
      @guide.metadata['description'].presence || @guide.metadata['subtitle'].presence ||
        @guide.body.split(/\n\s*\n/).find { |paragraph| paragraph.present? && !paragraph.lstrip.start_with?('#', '```', '~~~', '|', '<') }
    elsif controller_name == 'guides'
      'Install the JSN ServiceNow CLI, configure an instance, choose output formats, and follow guides for records, update sets and safe workflows.'
    elsif controller_name == 'pages' && action_name == 'index'
      if request.path.delete_suffix('/') == '/features'
        'Explore JSN ServiceNow CLI features, command examples and walkthroughs for setup, records, scripts, update sets and more.'
      else
        'Use JSN to work with ServiceNow from your terminal. Explore commands for records, scripts and update sets, with setup and safety guides.'
      end
    end
    truncate(strip_tags(text.to_s).squish, length: 160).presence
  end

  def page_canonical_url
    if controller_name == 'documentation' && action_name == 'show' && @document.present?
      # Reader identity is query-based. Use only the resolved document and
      # selected, validated release; tracking parameters never belong here.
      identity = { path: @document.fetch('path'), release: @release }
      return "https://jsn.jace.pro/documentation/read?#{identity.to_query}"
    end

    path = @guide ? @guide.url : request.path
    if path.match?(%r{\A/(features|docs)(/|\z)})
      path = "#{path.delete_suffix('/')}/"
    end
    "https://jsn.jace.pro#{path}"
  end
end
