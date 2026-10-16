const $ = id => document.getElementById(id);
const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
const section = (parent, heading, text) => { const box = element('section'); box.append(element('h3', heading), element('pre', text)); parent.append(box); };
const statusLabel = status => ({valid: 'Published · sources unchanged', dirty: 'Sources changed or first summary needed', blocked: 'Blocked by security review', missing: 'Sources unavailable', error: 'Run failed', noop: 'Sources unchanged', applied: 'Published', review_required: 'Needs review', unknown: 'Run information unavailable'}[status] ?? status);
let csrf, revision = 0;
async function api(query = '', options) {
  const response = await fetch(`/api/synthesis${query}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}
function message(text) { $('message').textContent = text; }
async function list() {
  const current = ++revision;
  $('review').replaceChildren(); $('groups').replaceChildren(); $('run').replaceChildren(element('option', 'Select a saved run')); $('run').firstChild.value = '';
  if (!$('scope').value) return;
  try {
    const data = await api(`?store=${encodeURIComponent($('scope').value)}`);
    if (current !== revision) return;
    for (const group of data.groups) {
      const article = element('article'); article.append(element('h3', `${group.group} · ${statusLabel(group.status)}`));
      article.append(element('pre', group.sources.map(s => s.kind === 'file' ? `Native Markdown: ${s.path}` : `Punk Records memory: ${s.ref}`).join('\n'))); $('groups').append(article);
    }
    if (!data.groups.length) $('groups').append(element('p', 'No synthesis groups configured in this scope.'));
    for (const run of data.runs) { const option = element('option', `${new Date(run.updated).toLocaleString()} · ${statusLabel(run.status)}${run.durationMs === null ? '' : ` · ${run.durationMs} ms`} · ${run.id.slice(0, 8)}`); option.value = run.id; $('run').append(option); }
    message(data.runs.length ? 'Select a run to review.' : 'No saved runs yet. Configured sources are listed above.');
  } catch (error) { if (current === revision) message(error.message); }
}
async function review() {
  const current = ++revision, store = $('scope').value, runId = $('run').value;
  $('review').replaceChildren(); if (!runId) return;
  try {
    const data = await api(`?store=${encodeURIComponent(store)}&run=${encodeURIComponent(runId)}`);
    if (current !== revision) return;
    const root = $('review'); root.append(element('h3', data.request.requestId ? `Request ${data.request.requestId}` : 'No work required'));
    if (data.report) {
      root.append(element('p', `${statusLabel(data.published ? 'applied' : data.report.status)} · ${data.report.durationMs ?? 'unknown'} ms · ${data.report.inputBytes ?? 'unknown'} input bytes · ${data.report.outputBytes ?? 'unknown'} output bytes. Token usage unavailable.`));
      for (const error of data.report.errors) root.append(element('pre', error));
    }
    for (const group of data.request.groups) {
      const article = element('article'); article.append(element('h2', group.group));
      const comparison = element('div'); comparison.className = 'comparison';
      const draft = data.response?.summaries.find(s => s.group === group.group);
      section(comparison, 'Previous published summary at capture', group.previousSummaryUnavailable ? 'Historical comparison withheld: its captured previous summary cannot be independently verified.' : group.previousSummary ?? 'No reusable previous summary.');
      section(comparison, draft ? `Draft: ${draft.title}` : 'Draft unavailable', draft?.summary ?? 'The runner has not saved a valid response.'); article.append(comparison);
      for (const source of group.sources) {
        const details = element('details'); details.append(element('summary', `${source.kind === 'file' ? 'Native Markdown' : 'Punk Records memory'} · ${source.memory.title} · ${source.path ?? source.id}`));
        details.append(element('p', `Captured version: ${source.hash}`), element('pre', JSON.stringify(source.memory, null, 2))); article.append(details);
      }
      root.append(article);
    }
    const publish = element('button', !data.request.groups.length ? 'No summaries to publish' : data.published ? 'Request published' : `Publish ${data.request.groups.length} ${data.request.groups.length === 1 ? 'summary' : 'summaries'}`); publish.id = 'publish'; publish.type = 'button'; publish.disabled = data.published || !!data.publishError;
    root.append(element('p', !data.request.groups.length ? 'This run did not need new summaries.' : data.published ? 'This request was published. Current sources may have changed since publication.' : data.publishError ? 'Publication unavailable: pending request or sources changed, evidence blocked, or response missing.' : 'Publishing replaces every summary in this request. Original memories and native files remain untouched.'), publish);
    publish.addEventListener('click', async () => {
      if (!confirm('Publish every draft summary in this request?')) return;
      publish.disabled = true;
      try {
        await api('/publish', {method: 'POST', headers: {'content-type': 'application/json', 'x-punk-records-csrf': csrf}, body: JSON.stringify({store, runId, requestId: data.request.requestId, reviewId: data.reviewId})});
        if (current === revision) { message('Entire request published.'); await review(); }
      } catch (error) { if (current === revision) { message(error.message); await review(); } }
    });
    message(!data.request.groups.length ? 'Sources unchanged; this run produced no drafts.' : data.published ? 'Published request.' : 'Compare the draft with every captured source before publication.');
  } catch (error) { if (current === revision) message(error.message); }
}
$('scope').addEventListener('change', list); $('run').addEventListener('change', review); $('refresh').addEventListener('click', async () => { await list(); });
try {
  const data = await api(); csrf = data.csrf;
  for (const store of data.stores) { const option = element('option', store.label); option.value = store.id; $('scope').append(option); }
  await list();
} catch (error) { message(error.message); }
