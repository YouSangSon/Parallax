import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { UI_CLIENT_JS } from '../src/ui/client.js';

function toolbar(messages: Record<string, string>, modernClipboard = true) {
  const listeners = new Map<string, () => Promise<void>>();
  const timers: Array<() => void> = [];
  const platform = { denied: true, downloads: 0, copies: 0, legacyCalls: 0,
    legacyResult: true as boolean | Error, removedTextareas: 0, copiedText: [] as string[] };
  const textareas = new Set<object>();
  let selectedText = '';
  const buttons = Object.fromEntries(['copyLinkButton', 'exportJsonButton', 'exportCsvButton', 'exportPngButton', 'copyCommandButton'].map((id) => [id, {
    textContent: id, dataset: {} as Record<string, string>, disabled: false,
    getAttribute: (name: string) => name === 'data-command' ? 'parallax analyze --changed src/login.ts' : null,
    addEventListener(_event: string, listener: () => Promise<void>) { listeners.set(id, listener); }
  }]));
  class BrowserUrl extends URL {
    static override createObjectURL(_blob: Blob): string {
      if (platform.denied) throw new Error('downloads unavailable');
      return 'blob:synthetic';
    }
    static override revokeObjectURL(_url: string): void {}
  }
  runInNewContext(UI_CLIENT_JS, {
    Blob, URL: BrowserUrl,
    navigator: modernClipboard ? { clipboard: { async writeText(value: string) {
      if (platform.denied) throw new Error('clipboard unavailable');
      platform.copies += 1;
      platform.copiedText.push(value);
    } } } : {},
    window: { location: new URL('http://localhost/?report=synthetic'), addEventListener() {},
      setTimeout(callback: () => void) { timers.push(callback); } },
    document: {
      documentElement: { lang: 'ko' }, body: { dataset: {}, append(element: object) { textareas.add(element); } },
      getElementById(id: string) {
        if (id === 'impact-data') return { textContent: '{}' };
        if (id === 'ui-messages') return { textContent: JSON.stringify(messages) };
        return buttons[id] ?? null;
      },
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === '.copy-command[data-command]' ? [buttons.copyCommandButton] : [],
      execCommand(command: string) {
        assert.equal(command, 'copy');
        platform.legacyCalls += 1;
        if (platform.legacyResult instanceof Error) throw platform.legacyResult;
        if (platform.legacyResult) platform.copiedText.push(selectedText);
        return platform.legacyResult;
      },
      createElement(tag: string) {
        const element = { value: '', style: {}, setAttribute() {},
          select() { selectedText = element.value; }, click() { platform.downloads += 1; },
          remove() { textareas.delete(element); if (tag === 'textarea') platform.removedTextareas += 1; } };
        return element;
      }
    }
  });
  return { buttons, platform, textareas, click: async (id: string) => { await listeners.get(id)!(); },
    settle() { while (timers.length) timers.shift()!(); } };
}

test('toolbar distinguishes export failures from clipboard failures in localized client messages', async () => {
  for (const [copyFailed, exportFailed] of [['Copy failed', 'Export failed'], ['복사 실패', '내보내기 실패'], ['复制失败', '导出失败']] as const) {
    const ui = toolbar({ copyFailed, exportFailed });
    for (const id of ['exportJsonButton', 'exportCsvButton', 'exportPngButton', 'copyLinkButton']) {
      await ui.click(id);
      assert.equal(ui.buttons[id]!.textContent, id === 'copyLinkButton' ? copyFailed : exportFailed, id);
      assert.equal(ui.buttons[id]!.dataset.state, 'failed');
      ui.settle();
      assert.equal(ui.buttons[id]!.textContent, id);
      assert.equal(ui.buttons[id]!.dataset.state, undefined);
    }
    assert.equal(ui.platform.downloads, 0, 'missing map and denied downloads create no file');
  }
  const fallback = toolbar({});
  await fallback.click('exportPngButton');
  assert.equal(fallback.buttons.exportPngButton!.textContent, 'Export failed');
  await fallback.click('copyLinkButton');
  assert.equal(fallback.buttons.copyLinkButton!.textContent, 'Copy failed');
});

test('legacy clipboard checks success, refusal and exceptions for both copy controls', async () => {
  for (const messages of [{ copyCopied: '복사됨', copyFailed: '복사 실패' }, {}]) {
    for (const result of [false, new Error('clipboard unavailable'), true]) {
      const ui = toolbar(messages, false);
      ui.platform.legacyResult = result;
      const success = result === true;
      for (const id of ['copyLinkButton', 'copyCommandButton']) {
        await ui.click(id);
        assert.equal(ui.buttons[id]!.textContent, success ? messages.copyCopied ?? 'Copied' : messages.copyFailed ?? 'Copy failed');
        assert.equal(ui.buttons[id]!.dataset.state, success ? 'copied' : 'failed', id);
        assert.equal(ui.textareas.size, 0, 'temporary textarea is removed after every outcome');
        if (id === 'copyCommandButton') assert.equal(ui.buttons[id]!.disabled, true);
        ui.settle();
        assert.equal(ui.buttons[id]!.textContent, id);
        assert.equal(ui.buttons[id]!.dataset.state, undefined);
        assert.equal(ui.buttons[id]!.disabled, false);
      }
      assert.equal(ui.platform.legacyCalls, 2);
      assert.equal(ui.platform.removedTextareas, 2);
      assert.deepEqual(ui.platform.copiedText, success ? ['http://localhost/?report=synthetic', 'parallax analyze --changed src/login.ts'] : []);
    }
  }
});

test('available Clipboard API remains preferred and rejection does not retry legacy copy', async () => {
  for (const denied of [true, false]) {
    const ui = toolbar({});
    ui.platform.denied = denied;
    for (const id of ['copyLinkButton', 'copyCommandButton']) {
      await ui.click(id);
      assert.equal(ui.buttons[id]!.dataset.state, denied ? 'failed' : 'copied');
      ui.settle();
      assert.equal(ui.buttons[id]!.disabled, false);
    }
    assert.equal(ui.platform.copies, denied ? 0 : 2);
    assert.equal(ui.platform.legacyCalls, 0);
    assert.equal(ui.platform.removedTextareas, 0);
    assert.equal(ui.textareas.size, 0);
  }
});

test('successful toolbar exports and copy retain their existing feedback and restoration', async () => {
  const ui = toolbar({ copyCopied: '복사됨', exportDone: '내보냄' });
  ui.platform.denied = false;
  for (const id of ['exportJsonButton', 'exportCsvButton', 'copyLinkButton']) {
    await ui.click(id);
    assert.equal(ui.buttons[id]!.textContent, id === 'copyLinkButton' ? '복사됨' : '내보냄');
    assert.equal(ui.buttons[id]!.dataset.state, 'copied');
    ui.settle();
    assert.equal(ui.buttons[id]!.textContent, id);
  }
  assert.equal(ui.platform.downloads, 2);
  assert.equal(ui.platform.copies, 1);
});
