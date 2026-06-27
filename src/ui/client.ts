// Static client-side script extracted verbatim from renderUiHtml. The
// surrounding <script> tags remain in src/ui.ts so the rendered HTML output
// stays byte-identical.

export const UI_CLIENT_JS = `    const snapshot = JSON.parse(document.getElementById('impact-data')?.textContent || '{}');
    const uiMessages = JSON.parse(document.getElementById('ui-messages')?.textContent || '{}');
    const affectedFiles = snapshot.selectedReport?.affectedFiles || [];
    const evidenceItems = snapshot.selectedReport?.evidence || [];
    const actionItems = snapshot.selectedReport?.actions || [];
    const input = document.getElementById('filterInput');
    const initialUrl = new URL(window.location.href);
    const initialFilter = initialUrl.searchParams.get('filter') || '';
    const initialImpactPathParam = initialUrl.searchParams.get('path') || '';
    const initialPresetParam = initialUrl.searchParams.get('preset') || '';
    function uiMessage(key, fallback) {
      return typeof uiMessages[key] === 'string' ? uiMessages[key] : fallback;
    }
    function workbenchState() {
      const current = new URL(window.location.href);
      return {
        report: current.searchParams.get('report') || snapshot.selectedReportId || '',
        lang: current.searchParams.get('lang') || document.documentElement.lang || 'en',
        path: current.searchParams.get('path') || document.body.dataset.selectedImpactPath || '',
        filter: current.searchParams.get('filter') || input?.value?.trim() || '',
        preset: current.searchParams.get('preset') || document.body.dataset.selectedPolicyPreset || ''
      };
    }
    function replaceWorkbenchState(updates) {
      if (!window.history?.replaceState) return;
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = '/';
      for (const [key, value] of Object.entries(updates)) {
        if (typeof value === 'string' && value.length > 0) {
          nextUrl.searchParams.set(key, value);
        } else {
          nextUrl.searchParams.delete(key);
        }
      }
      const search = nextUrl.searchParams.toString();
      window.history.replaceState(null, '', nextUrl.pathname + (search ? '?' + search : ''));
      refreshLanguageLinks();
    }
    function refreshLanguageLinks() {
      const state = workbenchState();
      for (const link of document.querySelectorAll('.lang-link[data-lang]')) {
        const lang = link.getAttribute('data-lang') || 'en';
        const nextUrl = new URL(window.location.href);
        nextUrl.pathname = '/';
        if (state.report) nextUrl.searchParams.set('report', state.report);
        nextUrl.searchParams.set('lang', lang);
        if (state.path) nextUrl.searchParams.set('path', state.path);
        if (state.filter) nextUrl.searchParams.set('filter', state.filter);
        if (state.preset) nextUrl.searchParams.set('preset', state.preset);
        link.setAttribute('href', nextUrl.pathname + '?' + nextUrl.searchParams.toString());
      }
    }
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
      const query = new URLSearchParams();
      query.set('path', file);
      query.set('line', String(line));
      const current = new URL(window.location.href);
      const report = current.searchParams.get('report');
      const lang = current.searchParams.get('lang');
      if (report) query.set('report', report);
      if (lang) query.set('lang', lang);
      return '/source?' + query.toString();
    }
    function evidenceSourceLabel(evidence) {
      const line = Number.isInteger(evidence.startLine) && evidence.startLine > 0 ? evidence.startLine : 1;
      const endLine = Number.isInteger(evidence.endLine) && evidence.endLine > line ? evidence.endLine : undefined;
      return endLine ? 'L' + line + '-L' + endLine : 'L' + line;
    }
    function isCrossRepoEvidence(evidence) {
      return evidence?.extractorId === 'cross-repo-contract-impact';
    }
    function evidenceHasLocalSource(evidence) {
      return !isCrossRepoEvidence(evidence) && typeof evidence?.file === 'string' && !evidence.file.includes('\\0');
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
    function exportFileBaseName(extension) {
      const id = snapshot.selectedReport?.id || snapshot.selectedReportId || 'workbench';
      return 'parallax-' + String(id).replace(/[^A-Za-z0-9._-]+/g, '-') + '.' + extension;
    }
    function downloadBlob(filename, type, content) {
      const blob = content instanceof Blob ? content : new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    function csvCell(value) {
      const text = String(value ?? '');
      return '"' + text.replaceAll('"', '""') + '"';
    }
    function exportJson() {
      const payload = {
        state: workbenchState(),
        generatedAt: snapshot.generatedAt,
        repoRoot: snapshot.repoRoot,
        report: snapshot.selectedReport,
        graph: snapshot.graph,
        comparison: snapshot.comparison
      };
      downloadBlob(exportFileBaseName('json'), 'application/json;charset=utf-8', JSON.stringify(payload, null, 2) + '\\n');
    }
    function exportCsv() {
      const actionByPath = new Map(actionItems.map((action) => [action.target?.path, actionCommandText(action)]));
      const header = ['path', 'confidence', 'depth', 'reason', 'evidence_count', 'verification_command'];
      const rows = affectedFiles.map((item) => [
        item.path,
        item.confidence,
        item.depth ?? '',
        item.reason,
        evidenceHitCount(item.path),
        actionByPath.get(item.path) || ''
      ]);
      downloadBlob(exportFileBaseName('csv'), 'text/csv;charset=utf-8', [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\\n') + '\\n');
    }
    function svgXmlForExport(svg) {
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const styleText = document.querySelector('style')?.textContent || '';
      if (styleText) {
        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = styleText;
        clone.insertBefore(style, clone.firstChild);
      }
      return new XMLSerializer().serializeToString(clone);
    }
    async function exportPng() {
      const svg = document.querySelector('.impact-svg');
      if (!svg) return;
      const xml = svgXmlForExport(svg);
      const width = Number(svg.getAttribute('width')) || 760;
      const height = Number(svg.getAttribute('height')) || 420;
      const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      try {
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas unavailable');
        context.fillStyle = '#fffdf4';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const pngBlob = await new Promise((resolve, reject) => {
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('png export failed')), 'image/png');
        });
        downloadBlob(exportFileBaseName('png'), 'image/png', pngBlob);
      } catch {
        downloadBlob(exportFileBaseName('svg'), 'image/svg+xml;charset=utf-8', xml);
      } finally {
        URL.revokeObjectURL(url);
      }
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
        empty.textContent = uiMessage('noVerificationActionRecorded', 'No verification action recorded.');
        target.append(empty);
        return;
      }
      const code = document.createElement('code');
      code.textContent = command;
      const button = document.createElement('button');
      button.className = 'copy-command';
      button.type = 'button';
      button.dataset.command = command;
      button.setAttribute('aria-label', uiMessage('ariaCopyInspectorCommand', 'Copy inspector verification command'));
      button.textContent = uiMessage('copy', 'Copy');
      target.append(code, button);
      wireCopyButton(button);
    }
    function renderMapAction(path) {
      const target = document.getElementById('mapNextAction');
      if (!target) return;
      target.replaceChildren();
      target.classList.remove('map-next-action-empty');
      const label = document.createElement('span');
      label.textContent = uiMessage('nextVerification', 'Next verification');
      const action = actionItems.find((candidate) => candidate.target?.path === path);
      const command = actionCommandText(action);
      if (!action || !command) {
        const empty = document.createElement('small');
        empty.textContent = uiMessage('noVerificationActionRecorded', 'No verification action recorded.');
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
      button.setAttribute('aria-label', uiMessage('ariaCopyMapCommand', 'Copy map verification command'));
      button.textContent = uiMessage('copy', 'Copy');
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
        empty.textContent = uiMessage('noMatchingEvidence', 'No matching evidence recorded.');
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
        const snippet = document.createElement('pre');
        snippet.textContent = String(item.snippet || '').length > 120
          ? String(item.snippet || '').slice(0, 117) + '...'
          : String(item.snippet || '');
        row.append(file, meta);
        if (evidenceHasLocalSource(item)) {
          const link = document.createElement('a');
          link.className = 'source-link';
          link.href = sourceHrefFor(item.file, line);
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = evidenceSourceLabel(item);
          row.append(link);
        }
        row.append(snippet);
        target.append(row);
      }
    }
    function laneLabelForImpact(item, hasCommand) {
      const pathLower = String(item?.path || '').toLowerCase();
      const reasonLower = String(item?.reason || '').toLowerCase();
      if (/\\bcross-repo\\b/i.test(reasonLower) || reasonLower.includes('breaks_compatibility_with')) {
        return uiMessage('crossRepoLane', 'Cross-repo consumers');
      }
      if (hasCommand || /(^|\\/)(tests?|__tests__)\\/|(^|\\/)src\\/test\\//.test(pathLower) || /(\\.|-)(test|spec)\\.[cm]?[tj]sx?$/.test(pathLower)) {
        return uiMessage('testsToVerify', 'Tests to verify');
      }
      if (pathLower.endsWith('.md') || /(^|\\/)(docs|doc|policies|policy|proposals|prd|requirements|decisions|adr)\\//.test(pathLower) || /\\b(governs|documents|requires|proposes)\\b/.test(reasonLower)) {
        return uiMessage('docsPolicy', 'Docs & policy');
      }
      if (/(^|\\/)(contracts?|apis?)\\//.test(pathLower) || /(^|[-_.])(openapi|asyncapi)([-_.]|$)/.test(pathLower) || /\\.(proto|graphql|gql|avsc)$/.test(pathLower) || /\\bcontract|endpoint|asyncapi|openapi|graphql|protobuf\\b/.test(reasonLower)) {
        return uiMessage('contractsLane', 'Contracts');
      }
      if (/(^|\\/)(\\.github\\/workflows|terraform|infra|deploy|k8s|helm)\\//.test(pathLower) || /(^|\\/)(dockerfile|makefile|compose\\.ya?ml)$/.test(pathLower) || /\\.(ya?ml|toml|json|jsonc|env|tf|tfvars|hcl|ini)$/.test(pathLower) || /(^|\\/)(package\\.json|pom\\.xml|build\\.gradle(?:\\.kts)?|go\\.mod|cargo\\.toml|pyproject\\.toml)$/.test(pathLower) || /\\b(configures|workflow|infra)\\b/.test(reasonLower)) {
        return uiMessage('configInfra', 'Config & infra');
      }
      return uiMessage('runtimeCode', 'Runtime code');
    }
    function updateImpactVerdict(item, evidenceCount, hasCommand) {
      let tone = 'teal';
      let label = uiMessage('evidenceReady', 'Evidence ready');
      if (evidenceCount === 0) {
        tone = 'red';
        label = uiMessage('needsEvidence', 'Needs evidence');
      } else if (item.confidence === 'heuristic' || item.confidence === 'unknown') {
        tone = 'amber';
        label = uiMessage('reviewBeforeChange', 'Review before change');
      } else if (hasCommand) {
        tone = 'green';
        label = uiMessage('readyToVerify', 'Ready to verify');
      }
      const meta = laneLabelForImpact(item, hasCommand) + ' · ' + item.confidence + ' · ' + evidenceCount + ' '
        + uiMessage('evidenceHits', 'Evidence hits') + ' · '
        + (hasCommand ? uiMessage('commandReady', 'command ready') : uiMessage('noCommandShort', 'no command'));
      const target = document.getElementById('inspectorVerdict');
      if (target) target.className = 'impact-verdict impact-verdict-' + tone;
      setText('inspectorVerdictLabel', label);
      setText('inspectorVerdictMeta', meta);
      const mapTarget = document.getElementById('mapImpactVerdict');
      if (mapTarget) mapTarget.className = 'map-impact-verdict impact-verdict-' + tone;
      setText('mapImpactVerdictLabel', label);
      setText('mapImpactVerdictMeta', meta);
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
      const selectedAction = actionItems.find((candidate) => candidate.target?.path === path);
      const selectedCommand = actionCommandText(selectedAction);
      const mapInsight = document.querySelector('.map-insight');
      const primaryChange = mapInsight?.getAttribute('data-primary-change') || uiMessage('changedRoot', 'Changed root');
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
      setText('mapFlowMeta', (item.reason || 'impacts') + ' · ' + affectedCount + ' ' + uiMessage('totalTargets', 'total targets') + ' · ' + displayedPathCount + ' ' + uiMessage('mappedPaths', 'mapped paths') + ' · ' + item.confidence + ' ' + uiMessage('confidenceInline', 'confidence'));
      renderMapAction(path);
      setText('inspectorPath', item.path);
      setText('inspectorReason', item.reason);
      setText('inspectorConfidence', item.confidence);
      setText('inspectorRelation', item.relationPath?.join(' -> ') || uiMessage('directOrNotRecorded', 'direct or not recorded'));
      setText('inspectorEvidence', String(matchingEvidence.length));
      updateImpactVerdict(item, matchingEvidence.length, Boolean(selectedCommand));
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
          link.textContent = uiMessage('ariaOpenSourceLabel', 'Open source') + ' ' + sourceLabel;
          sourceTarget.append(link);
        } else {
          sourceTarget.textContent = uiMessage('noSourceSpanRecorded', 'No source span recorded');
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
      if (options.updateUrl !== false) replaceWorkbenchState({ path });
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
    function applyFilter(queryText) {
      const query = String(queryText || '').trim().toLowerCase();
      for (const row of document.querySelectorAll('.filterable > li')) {
        const text = (row.getAttribute('data-filter-text') || row.textContent || '').toLowerCase();
        row.classList.toggle('hidden', query.length > 0 && !text.includes(query));
      }
    }
    input?.addEventListener('input', () => {
      const query = input.value.trim();
      applyFilter(query);
      replaceWorkbenchState({ filter: query });
    });
    document.getElementById('reportSelect')?.addEventListener('change', (event) => {
      const value = event.target.value;
      if (!value) return;
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = '/';
      nextUrl.searchParams.set('report', value);
      nextUrl.searchParams.delete('path');
      nextUrl.searchParams.delete('preset');
      window.location.href = nextUrl.pathname + '?' + nextUrl.searchParams.toString();
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
        const original = button.textContent || uiMessage('copy', 'Copy');
        button.disabled = true;
        try {
          await copyText(command);
          button.textContent = uiMessage('copyCopied', 'Copied');
          button.dataset.state = 'copied';
        } catch {
          button.textContent = uiMessage('copyFailed', 'Copy failed');
          button.dataset.state = 'failed';
        }
        window.setTimeout(() => {
          button.textContent = original;
          delete button.dataset.state;
          button.disabled = false;
        }, 1200);
      });
    }
    function setButtonState(button, state, label) {
      const original = button.dataset.originalText || button.textContent || '';
      button.dataset.originalText = original;
      button.textContent = label;
      button.dataset.state = state;
      window.setTimeout(() => {
        button.textContent = original;
        delete button.dataset.state;
      }, 1200);
    }
    function wireToolbarButton(id, handler, successLabel = uiMessage('copyCopied', 'Copied')) {
      const button = document.getElementById(id);
      if (!button) return;
      button.addEventListener('click', async () => {
        try {
          await handler();
          setButtonState(button, 'copied', successLabel);
        } catch {
          setButtonState(button, 'failed', uiMessage('copyFailed', 'Copy failed'));
        }
      });
    }
    for (const button of document.querySelectorAll('.copy-command[data-command]')) {
      wireCopyButton(button);
    }
    function selectPreset(preset, options = {}) {
      if (!preset) return;
      document.body.dataset.selectedPolicyPreset = preset;
      for (const row of document.querySelectorAll('.delta-preset[data-policy-preset]')) {
        row.classList.toggle('selected-preset', row.getAttribute('data-policy-preset') === preset);
      }
      if (options.updateUrl !== false) replaceWorkbenchState({ preset });
    }
    for (const row of document.querySelectorAll('.delta-preset[data-policy-preset]')) {
      row.addEventListener('click', (event) => {
        if (event.target?.closest?.('button')) return;
        selectPreset(row.getAttribute('data-policy-preset') || '');
      });
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        selectPreset(row.getAttribute('data-policy-preset') || '');
      });
    }
    wireToolbarButton('copyLinkButton', () => copyText(window.location.href));
    wireToolbarButton('exportJsonButton', exportJson, uiMessage('exportDone', 'Exported'));
    wireToolbarButton('exportCsvButton', exportCsv, uiMessage('exportDone', 'Exported'));
    wireToolbarButton('exportPngButton', exportPng, uiMessage('exportDone', 'Exported'));
    refreshLanguageLinks();
    if (input && initialFilter) {
      input.value = initialFilter;
      applyFilter(initialFilter);
    }
    if (initialPresetParam) selectPreset(initialPresetParam, { updateUrl: false });
    const firstImpactPath = affectedFiles.some((item) => item.path === initialImpactPathParam)
      ? initialImpactPathParam
      : initialImpactPath();
    if (firstImpactPath) selectImpact(firstImpactPath);`;
