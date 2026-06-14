// Static client-side script extracted verbatim from renderUiHtml. The
// surrounding <script> tags remain in src/ui.ts so the rendered HTML output
// stays byte-identical.

export const UI_CLIENT_JS = `    const snapshot = JSON.parse(document.getElementById('impact-data')?.textContent || '{}');
    const affectedFiles = snapshot.selectedReport?.affectedFiles || [];
    const evidenceItems = snapshot.selectedReport?.evidence || [];
    const actionItems = snapshot.selectedReport?.actions || [];
    const input = document.getElementById('filterInput');
    function evidenceMatchesPath(evidence, path) {
      return evidence.file === path || evidence.subject?.path === path || (evidence.snippet || '').includes(path);
    }
    function evidenceForPath(path) {
      return evidenceItems.filter((item) => evidenceMatchesPath(item, path));
    }
    function evidenceHitCount(path) {
      return evidenceForPath(path).length;
    }
    function setText(id, value) {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    }
    function sourceHrefFor(file, line) {
      return '/source?path=' + encodeURIComponent(file) + '&line=' + line;
    }
    function evidenceSourceLabel(evidence) {
      const line = Number.isInteger(evidence.startLine) && evidence.startLine > 0 ? evidence.startLine : 1;
      const endLine = Number.isInteger(evidence.endLine) && evidence.endLine > line ? evidence.endLine : undefined;
      return endLine ? 'L' + line + '-L' + endLine : 'L' + line;
    }
    function actionCommandText(action) {
      if (!action?.command) return '';
      return [action.command, ...(action.args || [])].map(shellQuoteForUi).join(' ');
    }
    function shortenMiddleForUi(value, maxLength) {
      const text = String(value || '');
      if (text.length <= maxLength) return text;
      const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
      return text.slice(0, keep) + '…' + text.slice(text.length - keep);
    }
    function shellQuoteForUi(value) {
      const displayValue = String(value)
        .replace(/\\n/g, '\\\\n')
        .replace(/\\r/g, '\\\\r')
        .replace(/\\t/g, '\\\\t');
      if (displayValue === '--') return displayValue;
      if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(displayValue) && !displayValue.startsWith('-')) return displayValue;
      return "'" + displayValue.replaceAll("'", "'\\\\''") + "'";
    }
    function renderInspectorAction(path) {
      const target = document.getElementById('inspectorAction');
      if (!target) return;
      target.replaceChildren();
      const action = actionItems.find((candidate) => candidate.target?.path === path);
      const command = actionCommandText(action);
      if (!action || !command) {
        const empty = document.createElement('span');
        empty.className = 'inspector-empty';
        empty.textContent = 'No verification action recorded.';
        target.append(empty);
        return;
      }
      const code = document.createElement('code');
      code.textContent = command;
      const button = document.createElement('button');
      button.className = 'copy-command';
      button.type = 'button';
      button.dataset.command = command;
      button.setAttribute('aria-label', 'Copy inspector verification command');
      button.textContent = 'Copy';
      target.append(code, button);
      wireCopyButton(button);
    }
    function renderMapAction(path) {
      const target = document.getElementById('mapNextAction');
      if (!target) return;
      target.replaceChildren();
      target.classList.remove('map-next-action-empty');
      const label = document.createElement('span');
      label.textContent = 'Next verification';
      const action = actionItems.find((candidate) => candidate.target?.path === path);
      const command = actionCommandText(action);
      if (!action || !command) {
        const empty = document.createElement('small');
        empty.textContent = 'No verification action recorded.';
        target.classList.add('map-next-action-empty');
        target.append(label, empty);
        return;
      }
      const code = document.createElement('code');
      code.textContent = command;
      const button = document.createElement('button');
      button.className = 'copy-command';
      button.type = 'button';
      button.dataset.command = command;
      button.setAttribute('aria-label', 'Copy map verification command');
      button.textContent = 'Copy';
      target.append(label, code, button);
      wireCopyButton(button);
    }
    function renderInspectorEvidence(evidence) {
      const target = document.getElementById('inspectorEvidenceList');
      if (!target) return;
      target.replaceChildren();
      if (evidence.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'inspector-empty';
        empty.textContent = 'No matching evidence recorded.';
        target.append(empty);
        return;
      }
      for (const item of evidence.slice(0, 3)) {
        const row = document.createElement('li');
        const file = document.createElement('strong');
        file.textContent = item.file;
        const meta = document.createElement('span');
        meta.textContent = item.kind + ' · ' + item.confidence;
        const line = Number.isInteger(item.startLine) && item.startLine > 0 ? item.startLine : 1;
        const link = document.createElement('a');
        link.className = 'source-link';
        link.href = sourceHrefFor(item.file, line);
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = evidenceSourceLabel(item);
        const snippet = document.createElement('pre');
        snippet.textContent = String(item.snippet || '').length > 120
          ? String(item.snippet || '').slice(0, 117) + '...'
          : String(item.snippet || '');
        row.append(file, meta, link, snippet);
        target.append(row);
      }
    }
    function confidenceRank(confidence) {
      if (confidence === 'proven') return 0;
      if (confidence === 'inferred') return 1;
      if (confidence === 'heuristic') return 2;
      return 3;
    }
    function compareImpactForUi(left, right) {
      return confidenceRank(left.confidence) - confidenceRank(right.confidence)
        || (left.depth ?? 99) - (right.depth ?? 99)
        || String(left.path).localeCompare(String(right.path));
    }
    function initialImpactPath() {
      const actionTargets = new Set(actionItems.map((action) => action.target?.path).filter(Boolean));
      const actionable = affectedFiles.filter((item) => actionTargets.has(item.path)).sort(compareImpactForUi);
      if (actionable[0]) return actionable[0].path;
      return [...affectedFiles].sort(compareImpactForUi)[0]?.path;
    }
    function selectImpact(path, options = {}) {
      const item = affectedFiles.find((candidate) => candidate.path === path);
      if (!item) return;
      const matchingEvidence = evidenceForPath(path);
      const mapInsight = document.querySelector('.map-insight');
      const primaryChange = mapInsight?.getAttribute('data-primary-change') || 'Changed root';
      const affectedCount = mapInsight?.getAttribute('data-affected-count') || String(affectedFiles.length);
      const displayedPathCount = mapInsight?.getAttribute('data-displayed-path-count') || String(affectedFiles.length);
      document.body.dataset.selectedImpactPath = path;
      const flowTarget = document.getElementById('mapFlowPath');
      if (flowTarget) {
        flowTarget.replaceChildren(
          document.createTextNode(shortenMiddleForUi(primaryChange, 34) + ' '),
          Object.assign(document.createElement('em'), { textContent: '→' }),
          document.createTextNode(' ' + shortenMiddleForUi(item.path, 34))
        );
      }
      setText('mapFlowMeta', (item.reason || 'impacts') + ' · ' + affectedCount + ' targets · ' + displayedPathCount + ' displayed paths · ' + item.confidence + ' confidence');
      renderMapAction(path);
      setText('inspectorPath', item.path);
      setText('inspectorReason', item.reason);
      setText('inspectorConfidence', item.confidence);
      setText('inspectorRelation', item.relationPath?.join(' -> ') || 'direct or not recorded');
      setText('inspectorEvidence', String(matchingEvidence.length));
      renderInspectorAction(path);
      renderInspectorEvidence(matchingEvidence);
      const firstEvidence = Array.from(document.querySelectorAll('.evidence-row'))
        .find((row) => row.getAttribute('data-impact-path') === path);
      const sourceHref = firstEvidence?.getAttribute('data-source-href') || '';
      const sourceLabel = firstEvidence?.getAttribute('data-source-label') || '';
      const sourceTarget = document.getElementById('inspectorSource');
      if (sourceTarget) {
        sourceTarget.replaceChildren();
        if (sourceHref) {
          const link = document.createElement('a');
          link.className = 'source-link';
          link.href = sourceHref;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = 'Open source ' + sourceLabel;
          sourceTarget.append(link);
        } else {
          sourceTarget.textContent = 'No source span recorded';
        }
      }
      for (const row of document.querySelectorAll('[data-impact-path]')) {
        const rowPath = row.getAttribute('data-impact-path');
        const isSelected = rowPath === path;
        const isRelatedEvidence = row.classList.contains('evidence-row') && rowPath === path;
        row.classList.toggle('selected-impact', isSelected && !row.classList.contains('evidence-row'));
        row.classList.toggle('related-evidence', isRelatedEvidence);
      }
      if (options.scroll) {
        document.querySelector('.evidence-row.related-evidence, .impact-row.selected-impact')?.scrollIntoView({
          block: 'nearest',
          behavior: 'smooth'
        });
      }
    }
    for (const element of document.querySelectorAll('.selectable-impact[data-impact-path]')) {
      element.addEventListener('click', () => selectImpact(element.getAttribute('data-impact-path'), { scroll: true }));
      element.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectImpact(element.getAttribute('data-impact-path'), { scroll: true });
      });
    }
    for (const element of document.querySelectorAll('.selectable-impact a, .selectable-impact button')) {
      element.addEventListener('click', (event) => event.stopPropagation());
    }
    input?.addEventListener('input', () => {
      const query = input.value.trim().toLowerCase();
      for (const row of document.querySelectorAll('.filterable > li')) {
        const text = (row.getAttribute('data-filter-text') || row.textContent || '').toLowerCase();
        row.classList.toggle('hidden', query.length > 0 && !text.includes(query));
      }
    });
    document.getElementById('reportSelect')?.addEventListener('change', (event) => {
      const value = event.target.value;
      if (value) window.location.href = '/?report=' + encodeURIComponent(value);
    });
    async function copyText(value) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.append(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        textarea.remove();
      }
    }
    function wireCopyButton(button) {
      if (!button || button.dataset.copyWired === 'true') return;
      button.dataset.copyWired = 'true';
      button.addEventListener('click', async () => {
        const command = button.getAttribute('data-command') || '';
        const original = button.textContent || 'Copy';
        button.disabled = true;
        try {
          await copyText(command);
          button.textContent = 'Copied';
          button.dataset.state = 'copied';
        } catch {
          button.textContent = 'Copy failed';
          button.dataset.state = 'failed';
        }
        window.setTimeout(() => {
          button.textContent = original;
          delete button.dataset.state;
          button.disabled = false;
        }, 1200);
      });
    }
    for (const button of document.querySelectorAll('.copy-command[data-command]')) {
      wireCopyButton(button);
    }
    const firstImpactPath = initialImpactPath();
    if (firstImpactPath) selectImpact(firstImpactPath);`;
