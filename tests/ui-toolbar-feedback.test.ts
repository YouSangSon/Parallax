import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { UI_CLIENT_JS } from '../src/ui/client.js';

function toolbar(messages: Record<string, string>) {
  const listeners = new Map<string, () => Promise<void>>();
  const timers: Array<() => void> = [];
  const platform = { denied: true, downloads: 0, copies: 0 };
  const buttons = Object.fromEntries(['copyLinkButton', 'exportJsonButton', 'exportCsvButton', 'exportPngButton'].map((id) => [id, {
    textContent: id, dataset: {} as Record<string, string>,
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
    navigator: { clipboard: { async writeText() {
      if (platform.denied) throw new Error('clipboard unavailable');
      platform.copies += 1;
    } } },
    window: { location: new URL('http://localhost/?report=synthetic'), addEventListener() {},
      setTimeout(callback: () => void) { timers.push(callback); } },
    document: {
      documentElement: { lang: 'ko' }, body: { dataset: {}, append() {} },
      getElementById(id: string) {
        if (id === 'impact-data') return { textContent: '{}' };
        if (id === 'ui-messages') return { textContent: JSON.stringify(messages) };
        return buttons[id] ?? null;
      },
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, click() { platform.downloads += 1; }, remove() {} })
    }
  });
  return { buttons, platform, click: async (id: string) => { await listeners.get(id)!(); },
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
