// Static stylesheet content extracted verbatim from renderUiHtml and
// renderSourceViewerHtml. The surrounding <style> tags remain in src/ui.ts so
// the rendered HTML output stays byte-identical.

export const UI_STYLES_MAIN = `    :root {
      color-scheme: light;
      --bg: #f2f4f1;
      --surface: #fffefa;
      --surface-subtle: #f7f5ee;
      --surface-strong: #20251f;
      --ink: #172019;
      --ink-inverse: #f8f4e8;
      --muted: #667067;
      --muted-inverse: #bcc8bd;
      --line: #d8d4c8;
      --line-strong: #b8b2a3;
      --green: #18735f;
      --amber: #a56312;
      --red: #b5423f;
      --teal: #1f6f78;
      --blue: #365f86;
      --graph: #263d32;
      --shadow: 0 18px 45px rgba(23, 32, 25, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(180deg, #f7f8f4 0, var(--bg) 280px),
        var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select { font: inherit; letter-spacing: 0; }
    .topbar {
      min-height: 78px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 14px 20px;
      border-bottom: 3px solid var(--green);
      background: var(--surface-strong);
      color: var(--ink-inverse);
      box-shadow: 0 10px 30px rgba(23, 32, 25, 0.16);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .title { min-width: 0; }
    .eyebrow {
      display: block;
      margin-bottom: 4px;
      color: #9ed3c4;
      font-size: 12px;
      font-weight: 700;
    }
    .title h1 { margin: 0; font-size: 22px; line-height: 1.15; }
    .title p { margin: 6px 0 0; color: var(--muted-inverse); font-size: 13px; overflow-wrap: anywhere; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .toolbar input, .toolbar select {
      min-height: 38px;
      border: 1px solid #566158;
      border-radius: 6px;
      background: #fbfaf5;
      color: var(--ink);
      padding: 0 12px;
      max-width: min(360px, 100%);
    }
    .toolbar input:focus, .toolbar select:focus {
      outline: 2px solid #9ed3c4;
      outline-offset: 2px;
    }
    .shell { width: min(1500px, 100%); margin: 0 auto; padding: 18px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(8, minmax(112px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .metric, .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric {
      min-height: 64px;
      padding: 10px 12px;
      border-top: 4px solid var(--blue);
      box-shadow: 0 8px 24px rgba(23, 32, 25, 0.05);
    }
    .metric:nth-child(2), .metric:nth-child(3) { border-top-color: var(--green); }
    .metric:nth-child(4) { border-top-color: var(--teal); }
    .metric:nth-child(5) { border-top-color: var(--amber); }
    .metric:nth-child(6) { border-top-color: var(--red); }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .metric strong {
      display: block;
      margin-top: 7px;
      font-size: 22px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .impact-triage {
      display: grid;
      grid-template-columns: minmax(220px, 0.42fr) minmax(0, 1fr);
      margin: 0 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .triage-head {
      display: grid;
      align-content: center;
      gap: 6px;
      min-width: 0;
      padding: 14px 16px;
      border-right: 1px solid rgba(248, 244, 232, 0.14);
      background: #18211b;
      color: var(--ink-inverse);
    }
    .triage-head h2 {
      margin: 0;
      color: #9ed3c4;
      font-size: 12px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .triage-head strong {
      font-size: 25px;
      line-height: 1;
      text-transform: capitalize;
    }
    .triage-head p {
      margin: 0;
      color: #bfd1c6;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .triage-flow {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 0;
      padding: 12px;
      background: #fbfaf5;
    }
    .triage-step {
      position: relative;
      min-width: 0;
      min-height: 78px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 5px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fffefa;
    }
    .triage-step:not(:last-child)::after {
      content: "→";
      position: absolute;
      right: -12px;
      top: 50%;
      z-index: 1;
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      transform: translateY(-50%);
      border: 1px solid #d7d2c4;
      border-radius: 999px;
      background: #fbfaf5;
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
    }
    .triage-step span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .triage-step strong {
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 15px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .triage-step small {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .triage-step-changed { border-left-color: var(--green); }
    .triage-step-affected { border-left-color: var(--teal); }
    .triage-step-action { border-left-color: var(--amber); }
    .triage-step.selectable-impact:hover {
      background: #f4fbf7;
      box-shadow: inset 0 0 0 1px #9fcdbd;
    }
    .impact-triage-wide .triage-head { box-shadow: inset 4px 0 0 var(--red); }
    .impact-triage-expanding .triage-head { box-shadow: inset 4px 0 0 var(--amber); }
    .impact-triage-contained .triage-head, .impact-triage-clear .triage-head { box-shadow: inset 4px 0 0 var(--green); }
    .report-delta-panel {
      margin: 0 0 14px;
    }
    .delta-content {
      display: grid;
      grid-template-columns: minmax(220px, 0.58fr) minmax(320px, 0.9fr) minmax(460px, 1.35fr);
      min-height: 150px;
    }
    .delta-hero {
      display: grid;
      align-content: center;
      gap: 6px;
      padding: 16px;
      border-right: 1px solid var(--line);
      background: #18211b;
      color: var(--ink-inverse);
    }
    .delta-hero span, .delta-hero small {
      color: #bfd1c6;
      font-size: 12px;
      line-height: 1.4;
    }
    .delta-hero strong {
      font-size: 27px;
      line-height: 1.05;
    }
    .delta-hero-wider { box-shadow: inset 4px 0 0 var(--amber); }
    .delta-hero-narrower { box-shadow: inset 4px 0 0 var(--green); }
    .delta-hero-unchanged { box-shadow: inset 4px 0 0 var(--teal); }
    .delta-metrics {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
      padding: 14px;
      border-right: 1px solid var(--line);
      background: #fffefa;
    }
    .delta-metrics li {
      display: grid;
      gap: 4px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: #fbfaf5;
    }
    .delta-metrics span, .delta-lane span, .delta-paths h3 {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .delta-metrics strong {
      color: var(--ink);
      font-size: 22px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .delta-metrics em {
      font-size: 11px;
      font-style: normal;
      font-weight: 800;
    }
    .delta-detail {
      display: grid;
      gap: 10px;
      padding: 14px;
      background: #fbfaf5;
      min-width: 0;
    }
    .delta-confidence {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .delta-confidence span {
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      background: #f5f3eb;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .delta-confidence b {
      margin-right: 4px;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    .delta-policy {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .delta-policy span {
      width: fit-content;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 3px 7px;
      background: #f3f7f4;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .delta-presets {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
      padding: 0;
    }
    .delta-preset {
      min-width: 0;
      display: grid;
      gap: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fffefa;
    }
    .delta-preset strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .delta-preset span {
      width: fit-content;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 6px;
      color: var(--muted);
      background: #f5f3eb;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .delta-preset b {
      color: var(--ink);
      font-size: 17px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .delta-preset small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .delta-preset .copy-command {
      justify-self: start;
      margin-top: 2px;
      min-height: 24px;
      padding: 2px 7px;
      font-size: 11px;
    }
    .delta-preset-wider { border-color: #d7b477; box-shadow: inset 3px 0 0 var(--amber); }
    .delta-preset-narrower { border-color: #89b6a5; box-shadow: inset 3px 0 0 var(--green); }
    .delta-preset-unchanged { border-color: #8bb8bc; box-shadow: inset 3px 0 0 var(--teal); }
    .delta-lanes {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
      padding: 0;
    }
    .delta-lane {
      display: grid;
      gap: 4px;
      min-width: 0;
      min-height: 68px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 8px;
      padding: 8px;
      background: #fffefa;
    }
    .delta-lane b {
      color: var(--ink);
      font-size: 17px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .delta-lane small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .delta-lane-green { border-left-color: var(--green); }
    .delta-lane-amber { border-left-color: var(--amber); }
    .delta-lane-teal { border-left-color: var(--teal); }
    .delta-lane-blue { border-left-color: var(--blue); }
    .delta-lane-red { border-left-color: var(--red); }
    .delta-paths {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .delta-paths section {
      min-width: 0;
    }
    .delta-paths h3 {
      margin: 0 0 6px;
    }
    .delta-paths ul {
      list-style: none;
      display: grid;
      gap: 4px;
      margin: 0;
      padding: 0;
    }
    .delta-paths li {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 5px 8px;
      align-items: center;
      overflow-wrap: anywhere;
      color: var(--ink);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .delta-paths li > span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .delta-paths li > small {
      grid-column: 1;
      color: var(--muted);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 11px;
      line-height: 1.25;
    }
    .delta-paths li > .source-link {
      grid-column: 2;
      grid-row: 1 / span 2;
      align-self: center;
    }
    .delta-positive strong, .delta-positive b, .delta-positive em { color: var(--amber); }
    .delta-negative strong, .delta-negative b, .delta-negative em { color: var(--green); }
    .delta-neutral strong, .delta-neutral b, .delta-neutral em { color: var(--teal); }
    .impact-overview {
      display: grid;
      grid-template-columns: minmax(680px, 1.65fr) minmax(320px, 0.72fr);
      gap: 14px;
      align-items: start;
      margin-bottom: 14px;
    }
    .workbench {
      display: grid;
      grid-template-columns: minmax(250px, 0.78fr) minmax(360px, 1.05fr) minmax(460px, 1.32fr);
      gap: 14px;
      align-items: start;
    }
    .stacked-pane {
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .panel {
      min-width: 0;
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .panel > h2, .panel-heading {
      margin: 0;
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #fffefa 0, var(--surface-subtle) 100%);
      color: #243126;
    }
    .panel > h2, .panel-heading h2 {
      font-size: 13px;
      font-weight: 800;
    }
    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-heading h2 { margin: 0; }
    .panel-chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .panel-chips span {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 7px;
      background: #f5f3eb;
    }
    .list { list-style: none; margin: 0; padding: 0; max-height: 540px; overflow: auto; }
    .evidence-panel .list { max-height: 680px; }
    .entity-row, .impact-row, .evidence-row, .action-row, .pack-row, .coverage-row, .work-artifact-row, .workspace-row, .workspace-link-row, .workspace-contract-row, .finding {
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
      min-width: 0;
    }
    .entity-row:hover, .impact-row:hover, .evidence-row:hover, .action-row:hover, .pack-row:hover, .coverage-row:hover, .work-artifact-row:hover, .workspace-row:hover, .workspace-link-row:hover, .workspace-contract-row:hover {
      background: #f8fbf7;
    }
    .entity-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; }
    .action-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      background: #fffefa;
    }
    .action-main {
      min-width: 0;
      display: grid;
      gap: 5px;
    }
    .action-main strong {
      display: block;
      overflow-wrap: anywhere;
      font-size: 13px;
    }
    .action-main span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .action-main code {
      width: fit-content;
      max-width: 100%;
      display: block;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 5px 7px;
      background: #f3f7f4;
      color: #263d32;
      white-space: pre-wrap;
    }
    .action-controls {
      grid-column: 2;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-start;
      gap: 6px;
    }
    .copy-command {
      min-height: 26px;
      border: 1px solid #89b6a5;
      border-radius: 6px;
      padding: 3px 8px;
      background: #eef8f3;
      color: var(--green);
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
    }
    .copy-command:hover {
      border-color: var(--green);
      background: #e2f2eb;
    }
    .copy-command:focus-visible {
      outline: 2px solid #73c2ac;
      outline-offset: 2px;
    }
    .copy-command[data-state="copied"] {
      border-color: #8bb8bc;
      background: #eef7f8;
      color: var(--teal);
    }
    .copy-command[data-state="failed"] {
      border-color: #d9a0a0;
      background: #fff1f0;
      color: var(--red);
    }
    .impact-row, .workspace-link-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .impact-path-row {
      align-items: start;
      background: #fffefa;
    }
    .impact-path-main {
      min-width: 0;
      display: grid;
      gap: 5px;
    }
    .impact-path-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      max-width: 220px;
    }
    .relation-trail {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
    }
    .relation-trail span {
      width: fit-content;
      max-width: 100%;
      border: 1px solid #d7b477;
      border-radius: 6px;
      padding: 2px 6px;
      background: #fff6e7;
      color: var(--amber);
      font-size: 11px;
      font-weight: 800;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .evidence-pill {
      width: fit-content;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 3px 8px;
      background: #f3f7f4;
      color: var(--graph);
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .impact-row strong, .pack-row strong, .coverage-row strong, .work-artifact-row strong, .workspace-row strong, .workspace-link-row strong, .workspace-contract-row strong { display: block; overflow-wrap: anywhere; }
    .impact-row strong, .evidence-meta strong, .coverage-row strong, .workspace-link-row strong {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
    }
    .impact-row span, .pack-row span, .coverage-row span, .work-artifact-row span, .work-artifact-row small, .workspace-row span, .workspace-link-row span, .workspace-link-row small, .workspace-contract-row span, .evidence-meta span {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .kind, .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 12px;
      white-space: nowrap;
      background: #f3f1e8;
      font-weight: 700;
    }
    .confidence-proven { color: var(--green); border-color: #89b6a5; background: #eef8f3; }
    .confidence-inferred { color: var(--teal); border-color: #8bb8bc; background: #eef7f8; }
    .confidence-heuristic { color: var(--amber); border-color: #d7b477; background: #fff6e7; }
    .confidence-low { color: var(--red); border-color: #d9a0a0; background: #fff1f0; }
    .freshness-current { color: var(--green); border-color: #89b6a5; background: #eef8f3; }
    .freshness-stale { color: var(--red); border-color: #d9a0a0; background: #fff1f0; }
    .freshness-unknown { color: var(--amber); border-color: #d7b477; background: #fff6e7; }
    .evidence-row { background: #fffefa; }
    .evidence-meta {
      display: grid;
      gap: 3px;
    }
    .source-link {
      width: fit-content;
      border: 1px solid #8bb8bc;
      border-radius: 6px;
      padding: 3px 8px;
      color: var(--teal);
      background: #eef7f8;
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .source-link:hover {
      background: #e2f2f4;
      border-color: var(--teal);
    }
    .source-link:focus-visible {
      outline: 2px solid #73c2ac;
      outline-offset: 2px;
    }
    pre {
      margin: 9px 0 0;
      padding: 10px;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      background: #f3f7f4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      color: #243126;
    }
    code { font-size: 12px; overflow-wrap: anywhere; color: var(--graph); }
    .impact-summary-panel {
      align-self: start;
      display: grid;
      grid-template-rows: auto auto auto auto auto minmax(0, 1fr);
    }
    .blast-card {
      margin: 14px;
      padding: 16px;
      border-radius: 8px;
      background: #18211b;
      color: var(--ink-inverse);
      box-shadow: inset 0 0 0 1px rgba(158, 211, 196, 0.24);
    }
    .blast-card span, .blast-card small {
      display: block;
      color: #bfd1c6;
      font-size: 12px;
      line-height: 1.45;
    }
    .blast-card strong {
      display: block;
      margin: 7px 0 5px;
      font-size: 31px;
      line-height: 1;
      text-transform: capitalize;
    }
    .analysis-trust {
      display: grid;
      gap: 8px;
      margin: 0 14px 14px;
      padding: 10px;
      border: 1px solid #d9ded5;
      border-radius: 8px;
      background: #fffefa;
    }
    .analysis-trust-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .analysis-trust-heading h3 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .analysis-trust-heading span {
      border: 1px solid #bad9ca;
      border-radius: 999px;
      padding: 2px 7px;
      background: #eef8f3;
      color: var(--green);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .analysis-trust-heading .trust-state-amber {
      border-color: #e0c999;
      background: #fff7e8;
      color: var(--amber);
    }
    .analysis-trust-heading .trust-state-red {
      border-color: #e3b8b2;
      background: #fff1ef;
      color: var(--red);
    }
    .trust-signals {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
      padding: 0;
    }
    .trust-signal {
      min-width: 0;
      display: grid;
      gap: 3px;
      border: 1px solid var(--line);
      border-top: 3px solid var(--line-strong);
      border-radius: 8px;
      padding: 7px;
      background: #fbfaf5;
    }
    .trust-signal span {
      color: var(--muted);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .trust-signal strong {
      color: var(--ink);
      font-size: 18px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .trust-signal small {
      color: var(--muted);
      font-size: 10px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .trust-signal-green { border-top-color: var(--green); }
    .trust-signal-amber { border-top-color: var(--amber); }
    .trust-signal-red { border-top-color: var(--red); }
    .trust-signal-blue { border-top-color: var(--blue); }
    .trust-gap-preview {
      list-style: none;
      display: grid;
      gap: 4px;
      margin: 0;
      padding: 0;
    }
    .trust-gap-preview li {
      border: 1px solid #e0c999;
      border-radius: 6px;
      padding: 5px 7px;
      background: #fff7e8;
      color: #7b520f;
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .confidence-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      padding: 0 14px 14px;
    }
    .confidence-meter {
      display: grid;
      gap: 3px;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfaf5;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .confidence-meter b {
      color: var(--ink);
      font-size: 18px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .impact-lanes {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
      padding: 0 14px 14px;
    }
    .impact-lane {
      min-width: 0;
      min-height: 76px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 4px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--line-strong);
      border-radius: 8px;
      padding: 9px 10px;
      background: #fbfaf5;
    }
    .impact-lane:hover {
      background: #f8fbf7;
    }
    .impact-lane span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .impact-lane b {
      color: var(--ink);
      font-size: 21px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .impact-lane small {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .impact-lane-green { border-left-color: var(--green); }
    .impact-lane-amber { border-left-color: var(--amber); }
    .impact-lane-teal { border-left-color: var(--teal); }
    .impact-lane-blue { border-left-color: var(--blue); }
    .impact-lane-red { border-left-color: var(--red); }
    .summary-columns {
      display: grid;
      grid-template-columns: 1fr;
      grid-auto-rows: max-content;
      align-content: start;
      min-height: 0;
      border-top: 1px solid var(--line);
    }
    .summary-section { min-width: 0; }
    .summary-section + .summary-section { border-top: 1px solid var(--line); }
    .summary-columns h3 {
      margin: 0;
      padding: 10px 14px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .summary-list { list-style: none; margin: 0; padding: 0; }
    .summary-list li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 10px 14px;
      border-top: 1px solid var(--line);
      min-width: 0;
    }
    .summary-list strong { display: block; overflow-wrap: anywhere; font-size: 13px; }
    .summary-list small { color: var(--muted); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .summary-list .empty { display: block; }
    .priority-row b {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      background: #edf5ef;
      color: var(--green);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .priority-row em { font-style: normal; }
    .selectable-impact {
      cursor: pointer;
      transition: background-color 120ms ease-out, box-shadow 120ms ease-out;
    }
    .selectable-impact:focus-visible {
      outline: 2px solid #73c2ac;
      outline-offset: -2px;
    }
    .selected-impact {
      background: #eef8f3 !important;
      box-shadow: inset 0 0 0 2px #73b29e;
    }
    .related-evidence {
      background: #f4fbf7 !important;
      box-shadow: inset 3px 0 0 #73b29e;
    }
    .map-panel {
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto;
      align-self: start;
    }
    .map-content {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      height: auto;
      min-height: 0;
      align-items: stretch;
    }
    .map-frame {
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto;
      align-content: start;
      align-items: start;
      gap: 12px;
      padding: 14px;
      background:
        linear-gradient(180deg, rgba(24, 33, 27, 0.97), rgba(24, 33, 27, 0.94)),
        #18211b;
    }
    .map-insight {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(180px, 0.42fr);
      align-items: center;
      gap: 12px;
      max-width: none;
      padding: 10px 12px;
      border: 1px solid rgba(168, 202, 186, 0.26);
      border-radius: 8px;
      background: rgba(15, 29, 22, 0.82);
      color: #e8f2eb;
    }
    .map-flow-text {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .map-flow-text span {
      color: #a8caba;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .map-flow-text strong {
      min-width: 0;
      color: #fffdf4;
      font-size: 17px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .map-flow-text em {
      color: #73c2ac;
      font-style: normal;
    }
    .map-flow-text small {
      color: #c9d8cf;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .map-next-action {
      min-width: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 5px 6px;
      align-items: center;
      padding: 8px;
      border: 1px solid rgba(115, 194, 172, 0.32);
      border-radius: 8px;
      background: rgba(234, 249, 241, 0.08);
    }
    .map-next-action span {
      grid-column: 1 / -1;
      color: #a8caba;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .map-next-action code {
      min-width: 0;
      overflow-wrap: anywhere;
      color: #f8fff9;
      font-size: 11px;
    }
    .map-next-action small {
      grid-column: 1 / -1;
      color: #c9d8cf;
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .map-next-action-empty {
      border-color: rgba(167, 179, 170, 0.32);
      background: rgba(255, 253, 244, 0.045);
    }
    .map-next-action .copy-command {
      min-height: 24px;
      padding: 2px 7px;
      border-color: #73c2ac;
      background: #e6f7ef;
    }
    .impact-route-strip {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(188px, 1fr));
      gap: 8px;
      margin: 0;
      padding: 0;
    }
    .impact-route-card {
      min-height: 58px;
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto;
      gap: 3px 8px;
      align-items: center;
      padding: 8px 9px;
      border: 1px solid rgba(168, 202, 186, 0.28);
      border-radius: 8px;
      background: rgba(255, 253, 244, 0.055);
      color: #f8fff9;
    }
    .impact-route-card.selectable-impact {
      cursor: pointer;
    }
    .impact-route-card b {
      grid-row: 1 / span 2;
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      background: rgba(115, 194, 172, 0.14);
      color: #b9e2d0;
      font-size: 11px;
    }
    .impact-route-card strong {
      min-width: 0;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.15;
    }
    .impact-route-card span {
      min-width: 0;
      overflow-wrap: anywhere;
      color: #c9d8cf;
      font-size: 10px;
      line-height: 1.2;
    }
    .impact-route-card em {
      grid-column: 3;
      grid-row: 1 / span 2;
      align-self: center;
      border: 1px solid rgba(168, 202, 186, 0.25);
      border-radius: 999px;
      padding: 2px 6px;
      background: rgba(255, 253, 244, 0.08);
      font-size: 10px;
      font-style: normal;
      font-weight: 900;
      text-transform: uppercase;
    }
    .impact-route-card.selected-impact {
      border-color: #73c2ac;
      background: #eef8f3 !important;
      color: #102119;
    }
    .impact-route-card.selected-impact strong {
      color: #102119;
    }
    .impact-route-card.selected-impact span {
      color: #41564b;
    }
    .impact-route-card.selected-impact b {
      background: #d9f1e6;
      color: var(--green);
    }
    .impact-svg {
      display: block;
      min-width: 0;
      width: 100%;
      max-width: 100%;
      height: 470px;
      filter: drop-shadow(0 16px 30px rgba(0, 0, 0, 0.18));
    }
    .map-stage {
      fill: rgba(255, 253, 244, 0.035);
      stroke: rgba(168, 202, 186, 0.16);
      stroke-width: 1;
    }
    .map-stage-affected {
      fill: rgba(255, 246, 231, 0.045);
      stroke: rgba(215, 180, 119, 0.22);
    }
    .map-column-label {
      fill: #a8caba;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .map-route-label {
      fill: #d2e1d7;
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .map-edge {
      fill: none;
      stroke: #73c2ac;
      stroke-width: 3;
      opacity: 0.88;
    }
    .map-edge-group.selectable-impact {
      cursor: pointer;
      outline: none;
    }
    .map-edge-group.selectable-impact:hover .map-edge,
    .map-edge-group.selected-impact .map-edge {
      stroke: #d9f6e7;
      stroke-width: 5;
      opacity: 1;
      filter: drop-shadow(0 0 8px rgba(115, 194, 172, 0.55));
    }
    .map-edge-group.selectable-impact:hover .map-edge-label,
    .map-edge-group.selected-impact .map-edge-label {
      fill: #0f1d16;
      stroke: #d9f6e7;
      stroke-width: 10px;
    }
    .map-edge-group:focus-visible .map-edge {
      stroke-width: 5;
      stroke: #d9f6e7;
    }
    .map-arrow {
      fill: #73c2ac;
    }
    .map-edge.confidence-heuristic {
      stroke: #d59a45;
      stroke-dasharray: 8 6;
    }
    .map-edge.confidence-inferred { stroke: #69b9c0; }
    .map-edge.confidence-unknown { stroke: #a7b3aa; stroke-dasharray: 4 5; }
    .map-edge-label {
      fill: #142017;
      paint-order: stroke;
      stroke: #f6f2e8;
      stroke-width: 8px;
      stroke-linejoin: round;
      font-size: 11px;
      font-weight: 800;
    }
    .map-node rect {
      fill: #fbfaf5;
      stroke: #d6ded4;
      stroke-width: 1.2;
    }
    .map-node circle { fill: var(--blue); }
    .map-node-changed rect {
      fill: #eef8f3;
      stroke: #73b29e;
    }
    .map-node-changed circle { fill: var(--green); }
    .map-node-affected rect {
      fill: #fff7e8;
      stroke: #d7b477;
    }
    .map-node-affected circle { fill: var(--amber); }
    .confidence-node-proven rect {
      fill: #eef8f3;
      stroke: #73b29e;
    }
    .confidence-node-proven circle { fill: var(--green); }
    .confidence-node-inferred rect {
      fill: #edf9fa;
      stroke: #81bbc0;
    }
    .confidence-node-inferred circle { fill: var(--teal); }
    .map-node-label {
      fill: #142017;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      font-weight: 800;
    }
    .map-node-kind {
      fill: #64706a;
      font-size: 11px;
      font-weight: 700;
    }
    .map-node-confidence {
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .map-node-lane-green .map-node-kind,
    .confidence-text-proven {
      fill: var(--green);
    }
    .map-node-lane-amber .map-node-kind,
    .confidence-text-heuristic {
      fill: var(--amber);
    }
    .map-node-lane-teal .map-node-kind,
    .confidence-text-inferred {
      fill: var(--teal);
    }
    .map-node-lane-blue .map-node-kind {
      fill: var(--blue);
    }
    .map-node-lane-red .map-node-kind,
    .confidence-text-low {
      fill: var(--red);
    }
    .confidence-text-unknown {
      fill: #64706a;
    }
    .map-node.selectable-impact rect {
      transition: fill 120ms ease-out, stroke 120ms ease-out, stroke-width 120ms ease-out;
    }
    .map-node.selected-impact rect {
      fill: #e0f4ea;
      stroke: #73c2ac;
      stroke-width: 2.5;
    }
    .map-legend {
      display: grid;
      grid-template-columns: minmax(270px, 1.15fr) minmax(170px, 0.55fr) minmax(210px, 0.8fr);
      align-content: start;
      align-items: start;
      gap: 12px;
      padding: 14px;
      border-top: 1px solid var(--line);
      background: #fbfaf5;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      overflow: visible;
    }
    .map-legend-key {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffefa;
    }
    .map-legend-key span {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-weight: 800;
      color: #27312a;
      white-space: nowrap;
    }
    .legend-swatch {
      width: 12px;
      height: 12px;
      flex: 0 0 12px;
      border-radius: 50%;
      background: var(--blue);
    }
    .legend-swatch.changed { background: var(--green); }
    .legend-swatch.affected { background: var(--amber); }
    .legend-swatch.context { background: var(--teal); }
    .map-route-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 10px 0 0 18px;
      border-top: 1px solid var(--line);
      max-height: 246px;
      overflow: auto;
    }
    .map-legend li strong {
      display: block;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .map-legend-edge.selectable-impact {
      cursor: pointer;
      border-radius: 8px;
      padding: 6px;
      margin-left: -6px;
    }
    .map-legend-edge.selectable-impact:hover,
    .map-legend-edge.selected-impact {
      background: #eef8f3;
      box-shadow: inset 0 0 0 2px #73b29e;
    }
    .map-legend li span {
      display: inline-block;
      margin: 3px 0;
      padding: 2px 6px;
      border: 1px solid #d7b477;
      border-radius: 6px;
      color: var(--amber);
      background: #fff6e7;
      font-size: 11px;
      font-weight: 800;
    }
    .impact-inspector {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 10px;
      border: 1px solid #9fcdbd;
      border-radius: 8px;
      background: #eef8f3;
      box-shadow: inset 4px 0 0 var(--green);
    }
    .impact-inspector h3 {
      margin: 0;
      color: var(--green);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .impact-inspector > strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      font-size: 15px;
    }
    .impact-inspector > span {
      color: var(--muted);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .impact-inspector dl {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 10px;
      margin: 0;
    }
    .impact-inspector dl div {
      display: grid;
      gap: 3px;
    }
    .impact-inspector dt {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .impact-inspector dd {
      margin: 0;
      color: var(--ink);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .inspector-action, .inspector-evidence {
      display: grid;
      gap: 6px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }
    .inspector-action {
      padding: 8px;
      border: 1px solid #b8d5c9;
      border-radius: 8px;
      background: #fbfffc;
    }
    .inspector-action h4, .inspector-evidence h4 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    #inspectorAction {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    #inspectorAction code {
      max-width: 100%;
      border: 1px solid #d9ded5;
      border-radius: 6px;
      padding: 4px 6px;
      background: #f3f7f4;
      white-space: pre-wrap;
    }
    .inspector-evidence ul, #inspectorEvidenceList {
      list-style: none;
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
    }
    .inspector-evidence {
      max-height: 246px;
      overflow: auto;
      padding-right: 2px;
    }
    #inspectorEvidenceList li {
      display: grid;
      gap: 4px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fffefa;
    }
    #inspectorEvidenceList strong {
      color: var(--ink);
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    #inspectorEvidenceList span {
      display: block;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
    }
    #inspectorEvidenceList pre {
      margin: 0;
      padding: 7px;
      font-size: 11px;
      line-height: 1.35;
    }
    .inspector-empty {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .bottom {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 0.8fr);
      gap: 14px;
      margin-top: 14px;
    }
    .wide-panel { margin-top: 14px; }
    .node-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--blue); }
    .node-dot.changed { background: var(--green); }
    .node-dot.affected { background: var(--amber); }
    .finding { display: grid; gap: 4px; }
    .finding-error strong { color: var(--red); }
    .finding-warn strong { color: var(--amber); }
    .finding-info strong { color: var(--teal); }
    .empty { padding: 18px; color: var(--muted); }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .topbar { grid-template-columns: 1fr; }
      .toolbar { justify-content: stretch; }
      .toolbar input, .toolbar select { width: 100%; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .impact-triage { grid-template-columns: 1fr; }
      .triage-head { border-right: 0; border-bottom: 1px solid var(--line); }
      .delta-content, .delta-paths { grid-template-columns: 1fr; }
      .delta-hero, .delta-metrics { border-right: 0; border-bottom: 1px solid var(--line); }
      .delta-lanes, .delta-presets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .impact-overview, .workbench, .bottom, .map-content, .summary-columns { grid-template-columns: 1fr; }
      .summary-columns > div:first-child, .map-legend { border-right: 0; border-left: 0; }
      .map-content {
        grid-template-columns: minmax(0, 1fr);
        height: auto;
      }
      .map-legend {
        grid-template-columns: 1fr;
      }
      .map-route-list,
      .inspector-evidence {
        max-height: none;
        overflow: visible;
      }
      .impact-svg { height: 380px; }
    }
    @media (max-width: 560px) {
      .shell { padding: 10px; }
      .topbar {
        position: static;
        min-height: 0;
        gap: 10px;
        padding: 10px 12px;
      }
      .eyebrow { margin-bottom: 3px; font-size: 10px; }
      .title h1 { font-size: 19px; }
      .title p {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.25;
      }
      .toolbar {
        display: grid;
        grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
        gap: 7px;
      }
      .toolbar input, .toolbar select {
        min-width: 0;
        min-height: 34px;
        padding: 0 8px;
      }
      .metrics {
        grid-template-columns: none;
        grid-auto-flow: column;
        grid-auto-columns: minmax(96px, 1fr);
        gap: 6px;
        margin-bottom: 10px;
        overflow-x: auto;
        overscroll-behavior-x: contain;
        padding-bottom: 2px;
        scroll-snap-type: x proximity;
        scrollbar-width: none;
      }
      .metrics::-webkit-scrollbar { display: none; }
      .metric {
        min-height: 48px;
        padding: 7px 8px;
        scroll-snap-align: start;
      }
      .metric span {
        font-size: 10px;
        line-height: 1.15;
      }
      .metric strong {
        margin-top: 5px;
        font-size: 16px;
        overflow-wrap: anywhere;
        white-space: nowrap;
      }
      .impact-triage { margin-bottom: 10px; }
      .triage-head {
        gap: 4px;
        padding: 10px 12px;
      }
      .triage-head h2 { font-size: 10px; }
      .triage-head strong { font-size: 21px; }
      .triage-head p {
        font-size: 11px;
        line-height: 1.25;
      }
      .triage-flow {
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 1.2fr);
        gap: 6px;
        padding: 8px;
      }
      .triage-step {
        min-height: 60px;
        gap: 3px;
        padding: 8px;
      }
      .triage-step:not(:last-child)::after {
        right: -9px;
        width: 14px;
        height: 14px;
        font-size: 9px;
      }
      .triage-step span { font-size: 9px; }
      .triage-step strong {
        font-size: 12px;
        line-height: 1.18;
      }
      .triage-step small {
        font-size: 10px;
        line-height: 1.2;
      }
      .panel > h2, .panel-heading { padding: 10px 12px; }
      .panel-heading {
        align-items: center;
        flex-direction: row;
        flex-wrap: wrap;
      }
      .panel-heading h2 { flex: 0 0 auto; }
      .panel-chips {
        flex: 1 1 170px;
        gap: 4px;
        justify-content: flex-start;
        min-width: 0;
        font-size: 10px;
      }
      .panel-chips span { padding: 2px 5px; }
      .map-frame {
        gap: 8px;
        padding: 10px;
      }
      .map-insight {
        grid-template-columns: 1fr;
        gap: 2px;
        padding: 8px 9px;
      }
      .map-flow-text strong { font-size: 14px; }
      .map-flow-text small { font-size: 11px; }
      .map-next-action {
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 6px 7px;
      }
      .impact-route-strip {
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .impact-route-card {
        min-height: 48px;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        gap: 3px 7px;
        padding: 7px 8px;
      }
      .impact-route-card b {
        width: 22px;
        height: 22px;
      }
      .impact-svg { height: 320px; }
      .map-legend { max-height: 300px; padding: 10px; overflow: auto; }
      .impact-row, .workspace-link-row, .action-row { grid-template-columns: 1fr; }
      .action-controls { grid-column: auto; justify-content: flex-start; }
      .impact-path-meta { justify-content: flex-start; max-width: none; }
      .confidence-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .trust-signals { grid-template-columns: 1fr; }
      .delta-metrics, .delta-lanes, .delta-presets { grid-template-columns: 1fr; }
    }`;

export const UI_STYLES_SOURCE_VIEWER = `    :root {
      color-scheme: light;
      --bg: #f2f4f1;
      --surface: #fffefa;
      --ink: #172019;
      --muted: #667067;
      --line: #d8d4c8;
      --green: #18735f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      display: grid;
      gap: 5px;
      padding: 16px 18px;
      border-bottom: 3px solid var(--green);
      background: #20251f;
      color: #f8f4e8;
    }
    header a {
      width: fit-content;
      color: #9ed3c4;
      font-size: 13px;
      font-weight: 800;
      text-decoration: none;
    }
    h1 {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 19px;
      line-height: 1.25;
    }
    header span {
      color: #bcc8bd;
      font-size: 13px;
    }
    main {
      width: min(1180px, 100%);
      margin: 0 auto;
      padding: 18px;
    }
    .source-card {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 18px 45px rgba(23, 32, 25, 0.08);
    }
    .source-card > div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    ol {
      margin: 0;
      padding: 12px 0 12px 58px;
      background: #f9fbf7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
    }
    li {
      padding: 0 14px 0 8px;
      color: #8b948b;
    }
    li code {
      color: #18211b;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .source-line-active {
      background: #e0f4ea;
      box-shadow: inset 4px 0 0 #18735f;
    }`;
