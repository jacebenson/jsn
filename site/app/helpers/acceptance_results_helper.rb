# frozen_string_literal: true

module AcceptanceResultsHelper
  # Reviewed against cli/test/acceptance/{read-only,read-only-catalog,resources,
  # workflows,auth}.mjs and cli/src/record-command-profiles.js. These names describe
  # the intended check, not proof that it ran. Never use private report titles.
  # Keep the ingestion allowlist separate and unchanged.
  SCENARIO_NAMES = {
    'auth.basic-expired-session' => 'Check Basic UI-session expiry and recovery',
    'auth.basic-invalid' => 'Reject invalid Basic login credentials',
    'auth.basic-rotation' => 'Rotate a test password and verify Basic login',
    'auth.basic-valid-permissions' => 'Verify Basic login, identity and permissions',
    'auth.cookie-expired-renewal' => 'Expire and renew a test browser session',
    'auth.cookie-invalid' => 'Reject invalid browser-session credentials',
    'auth.cookie-valid-permissions' => 'Verify browser-session login, identity and permissions',
    'auth.fixtures' => 'Create isolated, limited-permission test accounts',
    'local.completion' => 'Generate shell tab-completion script',
    'local.history-empty' => 'Read an empty, isolated change history',
    'local.parser-rejection' => 'Reject a records command with no table specified',
    'local.version' => 'Show the installed CLI version as text and JSON',
    'readonly.catalog.acls.list' => 'List access control rules',
    'readonly.catalog.acls.show' => 'Show an access control rule',
    'readonly.catalog.appmenu.list' => 'List application menus',
    'readonly.catalog.appmenu.show' => 'Show an application menu',
    'readonly.catalog.appmodules.list' => 'List application modules',
    'readonly.catalog.appmodules.show' => 'Show an application module',
    'readonly.catalog.assignments.list' => 'List assignment rules',
    'readonly.catalog.assignments.show' => 'Show an assignment rule',
    'readonly.catalog.asyncrules.list' => 'List asynchronous business rules',
    'readonly.catalog.asyncrules.show' => 'Show an asynchronous business rule',
    'readonly.catalog.catalogscripts.list' => 'List catalog client scripts',
    'readonly.catalog.catalogscripts.show' => 'Show a catalog client script',
    'readonly.catalog.cataloguipolicies.list' => 'List catalog UI policies',
    'readonly.catalog.cataloguipolicies.show' => 'Show a catalog UI policy',
    'readonly.catalog.changes.list' => 'List change requests',
    'readonly.catalog.changes.show' => 'Show a change request',
    'readonly.catalog.clientscripts.list' => 'List client scripts',
    'readonly.catalog.clientscripts.show' => 'Show a client script',
    'readonly.catalog.email.list' => 'List inbound email actions',
    'readonly.catalog.email.show' => 'Show an inbound email action',
    'readonly.catalog.incidents.list' => 'List incidents',
    'readonly.catalog.incidents.show' => 'Show an incident',
    'readonly.catalog.includes.list' => 'List script includes',
    'readonly.catalog.includes.show' => 'Show a script include',
    'readonly.catalog.listcontrols.list' => 'List list controls',
    'readonly.catalog.listcontrols.show' => 'Show a list control',
    'readonly.catalog.privileges.list' => 'List cross-scope privileges',
    'readonly.catalog.privileges.show' => 'Show a cross-scope privilege',
    'readonly.catalog.properties.list' => 'List system properties',
    'readonly.catalog.properties.show' => 'Show a system property',
    'readonly.catalog.relationships.list' => 'List record relationships',
    'readonly.catalog.relationships.show' => 'Show a record relationship',
    'readonly.catalog.requests.list' => 'List requested catalog items',
    'readonly.catalog.roles.list' => 'List roles',
    'readonly.catalog.roles.show' => 'Show a role',
    'readonly.catalog.rules.list' => 'List business rules',
    'readonly.catalog.rules.show' => 'Show a business rule',
    'readonly.catalog.scheduledjobs.list' => 'List scheduled script jobs',
    'readonly.catalog.scheduledjobs.show' => 'Show a scheduled script job',
    'readonly.catalog.scriptactions.list' => 'List script actions',
    'readonly.catalog.scriptactions.show' => 'Show a script action',
    'readonly.catalog.sppages.list' => 'List Service Portal pages',
    'readonly.catalog.sppages.show' => 'Show a Service Portal page',
    'readonly.catalog.spwidgets.list' => 'List Service Portal widgets',
    'readonly.catalog.spwidgets.show' => 'Show a Service Portal widget',
    'readonly.catalog.tables.list' => 'List table definitions',
    'readonly.catalog.tasks.list' => 'List catalog tasks',
    'readonly.catalog.tasks.show' => 'Show a catalog task',
    'readonly.catalog.triggers.list' => 'List event registrations',
    'readonly.catalog.triggers.show' => 'Show an event registration',
    'readonly.catalog.uiactions.list' => 'List UI actions',
    'readonly.catalog.uiactions.show' => 'Show a UI action',
    'readonly.catalog.uimacros.list' => 'List UI macros',
    'readonly.catalog.uimacros.show' => 'Show a UI macro',
    'readonly.catalog.uipages.list' => 'List UI pages',
    'readonly.catalog.uipages.show' => 'Show a UI page',
    'readonly.catalog.uipolicies.list' => 'List UI policies',
    'readonly.catalog.uipolicies.show' => 'Show a UI policy',
    'readonly.catalog.uxapplicability.list' => 'List UX applicability records',
    'readonly.catalog.uxapplicability.show' => 'Show a UX applicability record',
    'readonly.catalog.uxlists.list' => 'List workspace lists',
    'readonly.catalog.uxlists.show' => 'Show a workspace list',
    'readonly.catalog.uxscripts.list' => 'List UX scripts',
    'readonly.catalog.uxscripts.show' => 'Show a UX script',
    'readonly.catalog.views.list' => 'List UI views',
    'readonly.catalog.views.show' => 'Show a UI view',
    'readonly.records' => 'List and fetch table metadata with independent verification',
    'resources.clientscripts' => 'Create, read, update and delete test client scripts',
    'resources.includes' => 'Create, read, update and delete test script includes',
    'resources.properties' => 'Create, read, update and delete test system properties',
    'resources.rules' => 'Create, read, update and delete test business rules',
    'resources.scheduledjobs' => 'Create, read, update and delete test scheduled script jobs',
    'resources.uiactions' => 'Create, read, update and delete test UI actions',
    'resources.uipolicies' => 'Create, read, update and delete test UI policies',
    'resources.views' => 'Create, read, update and delete test UI views',
    'workflows.catalog-fulfillment' => 'Create and order a test catalog item, then verify fulfillment',
    'workflows.context' => 'Select an isolated update set and preserve the application context',
    'workflows.flow-lifecycle' => 'Create, edit, publish and test an isolated flow',
    'workflows.interactive' => 'Check interactive workflow changes and cancellation',
    'workflows.update-set-transfer' => 'Import, preview and commit a test update set, then verify its property'
  }.freeze

  STATUS_EXPLANATIONS = {
    'passed' => 'Passed: checks completed successfully',
    'failed' => 'Failed: checks did not pass',
    'failed-timeout' => 'Failed: test timed out',
    'blocked-prerequisite' => 'Not run: prerequisite did not complete',
    'blocked-access' => 'Blocked: access was denied',
    'blocked-capability' => 'Blocked: required capability unavailable',
    'excluded-mode' => 'Not run: excluded from this run mode',
    'not-run' => 'Not run: test was not executed'
  }.freeze

  def acceptance_scenario_name(id)
    SCENARIO_NAMES.fetch(id, 'Unrecognized test')
  end

  def acceptance_related_issue(check)
    # Related catalog mapping bug, not a diagnosis inferred from this status.
    return unless check.check_id == 'readonly.catalog.uxapplicability.list' && check.status == 'blocked-capability'

    'https://github.com/jacebenson/jsn/issues/435'
  end

  # Explain only the closed status, not a guessed provider error or root cause.
  def acceptance_status_explanation(status)
    STATUS_EXPLANATIONS.fetch(status, 'Status unavailable')
  end
end
