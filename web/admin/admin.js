(function startAdminPanel(global, document) {
  'use strict';

  const auth = global.CCGC_ADMIN_AUTH;
  const state = {
    accessToken: '',
    enrollment: undefined,
    access: {
      bindings: [],
      enrollments: [],
      cursor: undefined,
      nextCursor: undefined,
      history: [],
      page: 1,
      loaded: false,
    },
  };
  const reduceMotion = global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const elements = {
    sessionState: document.querySelector('#session-state'),
    sessionDetail: document.querySelector('#session-detail'),
    sessionAction: document.querySelector('#session-action'),
    globalMessage: document.querySelector('#global-message'),
    refreshStatus: document.querySelector('#refresh-status'),
    readiness: document.querySelector('.readiness'),
    brokerStatus: document.querySelector('#broker-status'),
    gatewayStatus: document.querySelector('#gateway-status'),
    databaseStatus: document.querySelector('#database-status'),
    brokerIndicator: document.querySelector('#broker-indicator'),
    gatewayIndicator: document.querySelector('#gateway-indicator'),
    databaseIndicator: document.querySelector('#database-indicator'),
    enrollmentForm: document.querySelector('#enrollment-form'),
    enrollmentError: document.querySelector('#enrollment-error'),
    enrollmentResult: document.querySelector('#enrollment-result'),
    enrollmentCode: document.querySelector('#enrollment-code'),
    resultLogin: document.querySelector('#result-login'),
    resultObjectId: document.querySelector('#result-object-id'),
    resultExpiry: document.querySelector('#result-expiry'),
    generatedInstructions: document.querySelector('#generated-instructions'),
    instructionTemplate: document.querySelector('#instruction-template'),
    bindingRevokeForm: document.querySelector('#binding-revoke-form'),
    keyRevokeForm: document.querySelector('#key-revoke-form'),
    refreshAccess: document.querySelector('#refresh-access'),
    accessLoading: document.querySelector('#access-loading'),
    accessError: document.querySelector('#access-error'),
    bindingsEmpty: document.querySelector('#bindings-empty'),
    bindingsTableWrap: document.querySelector('#bindings-table-wrap'),
    bindingsBody: document.querySelector('#bindings-body'),
    enrollmentsEmpty: document.querySelector('#enrollments-empty'),
    enrollmentsList: document.querySelector('#enrollments-list'),
    activeBindingCount: document.querySelector('#active-binding-count'),
    revokedBindingCount: document.querySelector('#revoked-binding-count'),
    pendingEnrollmentCount: document.querySelector('#pending-enrollment-count'),
    accessPrevious: document.querySelector('#access-previous'),
    accessNext: document.querySelector('#access-next'),
    accessPageLabel: document.querySelector('#access-page-label'),
  };

  function setGlobalMessage(message, kind) {
    elements.globalMessage.textContent = message;
    elements.globalMessage.className = `message ${kind ?? ''}`.trim();
    elements.globalMessage.classList.toggle('hidden', !message);
  }

  function errorMessage(error) {
    if (error instanceof Error && error.message) return error.message;
    return 'The request could not be completed.';
  }

  function setBusy(button, busy, busyLabel) {
    if (!(button instanceof HTMLButtonElement)) return;
    if (busy) {
      button.dataset.label = button.textContent ?? '';
      button.textContent = busyLabel;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.label ?? button.textContent;
      button.disabled = false;
    }
  }

  function setIndicator(element, status) {
    element.className = `status-indicator ${status}`;
  }

  async function acquireToken() {
    if (!auth?.isConfigured || typeof auth.acquireToken !== 'function') {
      throw new Error('Browser Entra authentication is not configured. Install the deployment auth adapter before using administrator actions.');
    }
    const token = await auth.acquireToken();
    if (typeof token !== 'string' || token.length < 20 || /[\r\n]/.test(token)) {
      throw new Error('The browser authentication adapter returned an invalid access token.');
    }
    state.accessToken = 'active';
    elements.sessionState.textContent = 'Signed in';
    elements.sessionDetail.textContent = 'CCGC.Admin token held in memory';
    elements.sessionAction.textContent = 'Sign out';
    if (typeof auth.principal === 'function') {
      const principal = await auth.principal();
      const label = principal?.displayName || principal?.username;
      if (label) elements.sessionState.textContent = label;
    }
    return token;
  }

  async function api(path, body) {
    const token = await acquireToken();
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`The broker returned an unreadable response with HTTP ${response.status}.`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        state.accessToken = '';
        if (typeof auth?.signOut === 'function') await auth.signOut();
        elements.sessionState.textContent = 'Authorization required';
        elements.sessionDetail.textContent = 'Sign in with a CCGC.Admin account';
        elements.sessionAction.textContent = 'Sign in';
      }
      const message = payload?.error?.message;
      throw new Error(typeof message === 'string'
        ? message
        : `The broker returned HTTP ${response.status}.`);
    }
    return payload;
  }

  function navigate(viewName) {
    for (const item of document.querySelectorAll('[data-view]')) {
      const active = item.getAttribute('data-view') === viewName;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    for (const panel of document.querySelectorAll('[data-panel]')) {
      const active = panel.getAttribute('data-panel') === viewName;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    }
    setGlobalMessage('', '');
    document.querySelector(`[data-panel="${viewName}"] h1`)?.focus?.();
    if (viewName === 'access' && !state.access.loaded) void refreshAccess();
  }

  function createElement(tag, className, textContent) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (textContent !== undefined) item.textContent = textContent;
    return item;
  }

  function formatDate(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function statusBadge(label, kind) {
    return createElement('span', `status-badge ${kind}`, label);
  }

  function setCellLabel(cell, label) {
    cell.dataset.label = label;
    return cell;
  }

  function apiKeyState(key) {
    if (key.revokedAt) return { label: 'Revoked', kind: 'revoked' };
    if (Date.parse(key.expiresAt) <= Date.now()) return { label: 'Expired', kind: 'expired' };
    return { label: 'Active', kind: 'active' };
  }

  function enrollmentState(enrollment) {
    if (enrollment.consumedAt) return { label: 'Consumed', kind: 'active', open: false };
    if (Date.parse(enrollment.expiresAt) <= Date.now()) return { label: 'Expired', kind: 'expired', open: false };
    if (enrollment.status === 'completed') return { label: 'Ready', kind: 'ready', open: true };
    const label = enrollment.status === 'authorizing'
      ? 'Authorizing'
      : enrollment.status === 'finalizing'
        ? 'Finalizing'
        : 'Pending';
    return { label, kind: enrollment.status, open: true };
  }

  function prepareBindingRevocation(binding) {
    const tenant = elements.bindingRevokeForm.elements.namedItem('tenantId');
    const objectId = elements.bindingRevokeForm.elements.namedItem('objectId');
    if (tenant instanceof HTMLInputElement) tenant.value = binding.tenantId;
    if (objectId instanceof HTMLInputElement) objectId.value = binding.objectId;
    navigate('revoke');
    setGlobalMessage(`Review the prefilled revocation for @${binding.githubLogin}.`, '');
    const evidence = elements.bindingRevokeForm.elements.namedItem('evidence');
    if (evidence instanceof HTMLTextAreaElement) evidence.focus();
  }

  function prepareKeyRevocation(key) {
    const id = elements.keyRevokeForm.elements.namedItem('id');
    if (id instanceof HTMLInputElement) id.value = key.id;
    navigate('revoke');
    setGlobalMessage(`Review the prefilled revocation for API key ${key.label}.`, '');
    const evidence = elements.keyRevokeForm.elements.namedItem('evidence');
    if (evidence instanceof HTMLTextAreaElement) evidence.focus();
  }

  function renderApiKeys(binding) {
    const details = createElement('details', 'api-key-details');
    const summary = createElement(
      'summary',
      '',
      `${binding.apiKeys.length} API ${binding.apiKeys.length === 1 ? 'key' : 'keys'}`,
    );
    details.append(summary);
    const list = createElement('div', 'api-key-list');
    for (const key of binding.apiKeys) {
      const item = createElement('div', 'api-key-item');
      const copy = createElement('div');
      copy.append(
        createElement('strong', '', key.label),
        createElement('span', 'identifier', key.id),
        createElement(
          'span',
          'metadata',
          key.revokedAt
            ? `Created ${formatDate(key.createdAt)}. Revoked ${formatDate(key.revokedAt)}.`
            : `Created ${formatDate(key.createdAt)}. Expires ${formatDate(key.expiresAt)}. Last used ${formatDate(key.lastUsedAt)}.`,
        ),
      );
      const status = apiKeyState(key);
      item.append(copy, statusBadge(status.label, status.kind));
      const revoke = createElement('button', 'button small secondary', 'Revoke');
      revoke.type = 'button';
      revoke.disabled = status.kind !== 'active';
      revoke.addEventListener('click', () => prepareKeyRevocation(key));
      item.append(revoke);
      list.append(item);
    }
    details.append(list);
    return details;
  }

  function renderBindings() {
    elements.bindingsBody.replaceChildren();
    const bindings = state.access.bindings;
    elements.bindingsEmpty.classList.toggle('hidden', bindings.length !== 0);
    elements.bindingsTableWrap.classList.toggle('hidden', bindings.length === 0);
    let active = 0;
    let revoked = 0;
    for (const binding of bindings) {
      const row = document.createElement('tr');
      const identity = setCellLabel(document.createElement('td'), 'Employee');
      const identityCopy = createElement('div', 'identity-cell');
      identityCopy.append(
        createElement('strong', '', `@${binding.githubLogin}`),
        createElement('span', 'metadata', `GitHub account ${binding.githubAccountId}`),
        createElement('span', 'identifier', `Object ${binding.objectId}`),
        createElement('span', 'metadata', `Tenant ${binding.tenantId}. Revision ${binding.revision}.`),
      );
      if (binding.apiKeys.length) identityCopy.append(renderApiKeys(binding));
      else identityCopy.append(createElement('span', 'metadata', 'No enterprise API keys.'));
      identity.append(identityCopy);

      const models = setCellLabel(document.createElement('td'), 'Models');
      const modelList = createElement('div', 'model-list');
      for (const model of binding.models) modelList.append(createElement('span', 'model-tag', model));
      models.append(modelList);

      const updated = setCellLabel(document.createElement('td'), 'Updated');
      updated.textContent = formatDate(binding.updatedAt);

      const statusCell = setCellLabel(document.createElement('td'), 'State');
      const isRevoked = Boolean(binding.revokedAt);
      if (isRevoked) {
        revoked += 1;
        statusCell.append(
          statusBadge('Revoked', 'revoked'),
          createElement('div', 'metadata', formatDate(binding.revokedAt)),
        );
      } else {
        active += 1;
        statusCell.append(statusBadge('Active', 'active'));
      }

      const actions = setCellLabel(document.createElement('td'), 'Actions');
      const actionWrap = createElement('div', 'row-actions');
      const revoke = createElement('button', 'button small secondary', 'Revoke binding');
      revoke.type = 'button';
      revoke.disabled = isRevoked;
      revoke.addEventListener('click', () => prepareBindingRevocation(binding));
      actionWrap.append(revoke);
      actions.append(actionWrap);
      row.append(identity, models, updated, statusCell, actions);
      elements.bindingsBody.append(row);
    }
    elements.activeBindingCount.textContent = String(active);
    elements.revokedBindingCount.textContent = String(revoked);
  }

  function renderEnrollments() {
    elements.enrollmentsList.replaceChildren();
    const enrollments = state.access.enrollments;
    elements.enrollmentsEmpty.classList.toggle('hidden', enrollments.length !== 0);
    let open = 0;
    for (const enrollment of enrollments) {
      const status = enrollmentState(enrollment);
      if (status.open) open += 1;
      const item = createElement('article', 'enrollment-item');
      const header = document.createElement('header');
      const title = createElement('h3', '', enrollment.userEmail);
      header.append(title, statusBadge(status.label, status.kind));
      const details = document.createElement('dl');
      const values = [
        ['Alias', enrollment.userAlias],
        ['GitHub', `@${enrollment.githubLogin} (${enrollment.githubAccountId})`],
        ['Object ID', enrollment.objectId],
        ['Expires', formatDate(enrollment.expiresAt)],
        ['Created', formatDate(enrollment.createdAt)],
        ['Models', enrollment.models.join(', ')],
      ];
      if (enrollment.consumedAt) values.splice(5, 0, ['Consumed', formatDate(enrollment.consumedAt)]);
      for (const [label, value] of values) {
        const group = document.createElement('div');
        group.append(createElement('dt', '', label), createElement('dd', '', value));
        details.append(group);
      }
      item.append(header, details);
      elements.enrollmentsList.append(item);
    }
    elements.pendingEnrollmentCount.textContent = String(open);
  }

  function renderAccess() {
    renderBindings();
    renderEnrollments();
    elements.accessPrevious.disabled = state.access.history.length === 0;
    elements.accessNext.disabled = !state.access.nextCursor;
    elements.accessPageLabel.textContent = `Page ${state.access.page}`;
  }

  async function refreshAccess(cursor = state.access.cursor) {
    setBusy(elements.refreshAccess, true, 'Refreshing');
    elements.accessLoading.classList.remove('hidden');
    elements.accessError.classList.add('hidden');
    elements.accessError.textContent = '';
    try {
      const body = { limit: 25 };
      if (cursor) body.cursor = cursor;
      const result = await api('/ccgc/admin/access/query', body);
      if (!Array.isArray(result.bindings) || !Array.isArray(result.enrollments)) {
        throw new Error('The broker returned an invalid access inventory.');
      }
      state.access.bindings = result.bindings;
      state.access.enrollments = result.enrollments;
      state.access.cursor = cursor;
      state.access.nextCursor = typeof result.nextCursor === 'string'
        ? result.nextCursor
        : undefined;
      state.access.loaded = true;
      renderAccess();
    } catch (error) {
      elements.accessError.textContent = errorMessage(error);
      elements.accessError.classList.remove('hidden');
    } finally {
      elements.accessLoading.classList.add('hidden');
      setBusy(elements.refreshAccess, false, '');
    }
  }

  async function refreshStatus() {
    setBusy(elements.refreshStatus, true, 'Checking');
    elements.readiness.setAttribute('aria-busy', 'true');
    setGlobalMessage('', '');
    try {
      const status = await api('/ccgc/admin/status', {});
      elements.brokerStatus.textContent = status.status === 'ready' ? 'Ready for administration.' : 'Unexpected status.';
      elements.gatewayStatus.textContent = status.litellm === 'ready' ? 'LiteLLM readiness passed.' : 'Gateway is not ready.';
      elements.databaseStatus.textContent = status.enterpriseDatabase === 'initialized'
        ? 'Schema is initialized.'
        : 'Schema initialization is required.';
      setIndicator(elements.brokerIndicator, status.status === 'ready' ? 'ready' : 'error');
      setIndicator(elements.gatewayIndicator, status.litellm === 'ready' ? 'ready' : 'error');
      setIndicator(elements.databaseIndicator, status.enterpriseDatabase === 'initialized' ? 'ready' : 'error');
    } catch (error) {
      const message = errorMessage(error);
      elements.brokerStatus.textContent = message;
      elements.gatewayStatus.textContent = 'Not verified.';
      elements.databaseStatus.textContent = 'Not verified.';
      setIndicator(elements.brokerIndicator, 'error');
      setIndicator(elements.gatewayIndicator, 'neutral');
      setIndicator(elements.databaseIndicator, 'neutral');
      setGlobalMessage(message, 'error');
    } finally {
      elements.readiness.setAttribute('aria-busy', 'false');
      setBusy(elements.refreshStatus, false, '');
    }
  }

  function enrollmentInstructions(code) {
    return [
      'CCGC employee enrollment',
      '',
      `Broker: ${global.location.origin}`,
      `One-time code: ${code}`,
      '',
      'Save the tracked scripts/ccgc-enterprise-macos.sh file on your Mac, then run:',
      `bash ccgc-enterprise-macos.sh enroll --gateway ${global.location.origin} --code ${code}`,
      'bash ccgc-enterprise-macos.sh models',
      'claude',
      '',
      'Complete GitHub authorization with the GitHub account named by your administrator.',
      'After enrollment, do not run enroll again for routine updates; run the installed helper doctor first.',
    ].join('\n');
  }

  function showEnrollment(result) {
    state.enrollment = result;
    elements.enrollmentCode.textContent = result.code;
    elements.resultLogin.textContent = result.githubLogin;
    elements.resultObjectId.textContent = result.objectId;
    elements.resultExpiry.textContent = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(result.expiresAt));
    elements.generatedInstructions.textContent = enrollmentInstructions(result.code);
    elements.enrollmentResult.classList.remove('hidden');
    elements.enrollmentResult.scrollIntoView({
      block: 'start',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }

  function clearEnrollment() {
    state.enrollment = undefined;
    elements.enrollmentCode.textContent = '';
    elements.resultLogin.textContent = '';
    elements.resultObjectId.textContent = '';
    elements.resultExpiry.textContent = '';
    elements.generatedInstructions.textContent = '';
    elements.enrollmentResult.classList.add('hidden');
  }

  async function copyText(value, successMessage) {
    if (!global.navigator.clipboard?.writeText) {
      throw new Error('Clipboard access is unavailable. Select and copy the text manually.');
    }
    await global.navigator.clipboard.writeText(value);
    setGlobalMessage(successMessage, 'success');
  }

  async function submitEnrollment(event) {
    event.preventDefault();
    elements.enrollmentError.classList.add('hidden');
    elements.enrollmentError.textContent = '';
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const submit = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    setBusy(submit, true, 'Creating enrollment');
    clearEnrollment();
    try {
      const result = await api('/ccgc/admin/enrollments', {
        userEmail: String(data.get('userEmail') ?? '').trim(),
        githubLogin: String(data.get('githubLogin') ?? '').trim(),
      });
      state.access.loaded = false;
      showEnrollment(result);
      setGlobalMessage('Enrollment created. Copy the one-time code before leaving this page.', 'success');
    } catch (error) {
      elements.enrollmentError.textContent = errorMessage(error);
      elements.enrollmentError.classList.remove('hidden');
      elements.enrollmentError.focus();
    } finally {
      setBusy(submit, false, '');
    }
  }

  async function submitRevocation(event, path, confirmation, description) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const data = new FormData(form);
    const error = form.querySelector('[data-form-error]');
    error.classList.add('hidden');
    error.textContent = '';
    if (String(data.get('confirmation')) !== confirmation) {
      error.textContent = `Type ${confirmation} exactly to continue.`;
      error.classList.remove('hidden');
      return;
    }
    const identifier = String(data.get('objectId') ?? data.get('id') ?? '');
    if (!global.confirm(`${description}\n\nIdentifier: ${identifier}\n\nThis action cannot be undone.`)) return;
    const submit = form.querySelector('button[type="submit"]');
    setBusy(submit, true, 'Revoking');
    try {
      const body = path === '/ccgc/admin/revoke'
        ? {
            tenantId: String(data.get('tenantId') ?? '').trim(),
            objectId: String(data.get('objectId') ?? '').trim(),
            evidence: String(data.get('evidence') ?? '').trim(),
          }
        : {
            id: String(data.get('id') ?? '').trim(),
            evidence: String(data.get('evidence') ?? '').trim(),
          };
      await api(path, body);
      form.reset();
      state.access.loaded = false;
      setGlobalMessage(`${description} completed.`, 'success');
      global.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    } catch (requestError) {
      error.textContent = errorMessage(requestError);
      error.classList.remove('hidden');
      error.focus();
    } finally {
      setBusy(submit, false, '');
    }
  }

  async function sessionAction() {
    if (state.accessToken) {
      state.accessToken = '';
      clearEnrollment();
      if (typeof auth?.signOut === 'function') await auth.signOut();
      state.access.bindings = [];
      state.access.enrollments = [];
      state.access.cursor = undefined;
      state.access.nextCursor = undefined;
      state.access.history = [];
      state.access.page = 1;
      state.access.loaded = false;
      renderAccess();
      elements.sessionState.textContent = 'Not signed in';
      elements.sessionDetail.textContent = 'CCGC.Admin is required';
      elements.sessionAction.textContent = auth?.isConfigured ? 'Sign in' : 'Auth setup required';
      setGlobalMessage('Signed out. The in-memory access token was cleared.', 'success');
      return;
    }
    try {
      await acquireToken();
      elements.sessionAction.disabled = false;
      setGlobalMessage('Signed in with an administrator session.', 'success');
      await refreshStatus();
    } catch (error) {
      const message = errorMessage(error);
      const configurationFailure = /browser configuration|redirect URI/u.test(message);
      state.accessToken = '';
      elements.sessionState.textContent = configurationFailure ? 'Sign-in unavailable' : 'Not signed in';
      elements.sessionDetail.textContent = configurationFailure
        ? 'Administrator sign-in configuration could not be loaded'
        : 'Sign in with a CCGC.Admin account';
      elements.sessionAction.textContent = 'Sign in';
      elements.sessionAction.disabled = configurationFailure;
      elements.sessionAction.classList.remove('hidden');
      elements.sessionAction.removeAttribute('hidden');
      setGlobalMessage(message, 'error');
    }
  }

  for (const item of document.querySelectorAll('[data-view]')) {
    item.addEventListener('click', () => navigate(item.getAttribute('data-view')));
  }
  elements.sessionAction.addEventListener('click', sessionAction);
  elements.refreshStatus.addEventListener('click', refreshStatus);
  elements.refreshAccess.addEventListener('click', () => refreshAccess());
  elements.accessNext.addEventListener('click', () => {
    if (!state.access.nextCursor) return;
    state.access.history.push(state.access.cursor);
    state.access.page += 1;
    void refreshAccess(state.access.nextCursor);
  });
  elements.accessPrevious.addEventListener('click', () => {
    if (!state.access.history.length) return;
    const cursor = state.access.history.pop();
    state.access.page = Math.max(1, state.access.page - 1);
    void refreshAccess(cursor);
  });
  elements.enrollmentForm.addEventListener('submit', submitEnrollment);
  elements.bindingRevokeForm.addEventListener('submit', event =>
    submitRevocation(event, '/ccgc/admin/revoke', 'REVOKE', 'Employee binding revocation'));
  elements.keyRevokeForm.addEventListener('submit', event =>
    submitRevocation(event, '/ccgc/admin/api-keys/revoke', 'REVOKE KEY', 'Enterprise API key revocation'));
  document.querySelector('#clear-enrollment').addEventListener('click', clearEnrollment);
  document.querySelector('#copy-code').addEventListener('click', async () => {
    try {
      await copyText(state.enrollment?.code ?? '', 'Enrollment code copied.');
    } catch (error) {
      setGlobalMessage(errorMessage(error), 'error');
    }
  });
  document.querySelector('#copy-instructions').addEventListener('click', async () => {
    try {
      await copyText(elements.generatedInstructions.textContent, 'Employee instructions copied.');
    } catch (error) {
      setGlobalMessage(errorMessage(error), 'error');
    }
  });
  document.querySelector('#copy-template').addEventListener('click', async () => {
    try {
      await copyText(elements.instructionTemplate.textContent, 'Employee instructions copied.');
    } catch (error) {
      setGlobalMessage(errorMessage(error), 'error');
    }
  });

  elements.instructionTemplate.textContent = enrollmentInstructions('CCGC-ONE-TIME-CODE');
  renderAccess();
  if (!auth?.isConfigured) {
    elements.sessionAction.textContent = 'Auth setup required';
    elements.refreshStatus.disabled = true;
    elements.refreshAccess.disabled = true;
    setGlobalMessage(
      'The panel is installed, but browser Entra authentication is not configured. Administrator actions remain unavailable until the deployment auth adapter is supplied.',
      'error',
    );
  } else if (auth.hasPendingCallback) {
    elements.sessionAction.textContent = 'Completing sign-in';
    elements.sessionAction.disabled = true;
    void sessionAction();
  }
})(window, document);
