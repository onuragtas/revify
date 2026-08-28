// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DiffPanel from './DiffPanel.vue';
import { state } from '../bridge';

const FILE = {
  path: 'app.ts',
  diff: '@@ -10,3 +10,3 @@\n const a = 1;\n-const rate = 1;\n+const rate = 2;\n',
};

function setChanges(changes: unknown): void {
  state.issueKey = 'BUY-1';
  state.detail = { repoChanges: changes as never };
}

beforeEach(() => {
  // matchMedia is not implemented by happy-dom; the panel asks it whether
  // there is room for two columns.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('revifyHost', { setTabCount: () => {} });
  setChanges([{ projectPath: 'team/orders', baseBranch: 'main', branchName: 'feat', files: [FILE] }]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
  state.detail = null;
});

describe('DiffPanel', () => {
  it('says so when there is nothing to show', () => {
    setChanges([]);
    expect(mount(DiffPanel).text()).toContain('Gösterilecek değişiklik yok');
  });

  it('shows old and new side by side by default', () => {
    const wrapper = mount(DiffPanel);
    expect(wrapper.find('table').classes()).not.toContain('unified');
    expect(wrapper.find('td.oldSide').text()).toBe('const a = 1;');
    // The replaced line and its replacement sit in one row.
    const modified = wrapper.findAll('tr').find((r) => r.classes().includes('del'));
    expect(modified!.findAll('td.side').map((c) => c.text())).toEqual([
      'const rate = 1;',
      'const rate = 2;',
    ]);
  });

  it('switches to one column and remembers the choice', async () => {
    const wrapper = mount(DiffPanel);
    await wrapper.findAll('.seg button')[1].trigger('click');
    await nextTick();

    expect(wrapper.find('table').classes()).toContain('unified');
    expect(localStorage.getItem('ar-diff-mode')).toBe('unified');
    // A modification is two rows here, so you can read what replaced what.
    expect(wrapper.findAll('tr.del')).toHaveLength(1);
    expect(wrapper.findAll('tr.add')).toHaveLength(1);
  });

  it('ignores the remembered choice when there is no room for it', () => {
    // Half of a phone-width column is a few words per line, so side by side
    // is not a preference that can be honoured there.
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    localStorage.setItem('ar-diff-mode', 'split');
    expect(mount(DiffPanel).find('table').classes()).toContain('unified');
  });

  it('names each repository when the change spans more than one', async () => {
    setChanges([
      { projectPath: 'team/orders', baseBranch: 'main', branchName: 'feat', files: [FILE] },
      { projectPath: 'team/gateway', baseBranch: 'main', branchName: 'feat', files: [FILE] },
    ]);
    await nextTick();

    const text = mount(DiffPanel).text();
    expect(text).toContain('2 repo, 2 dosya');
    expect(text).toContain('team/orders');
    expect(text).toContain('team/gateway');
  });

  it('leaves a large change collapsed rather than dumping it on screen', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...FILE, path: `f${i}.ts` }));
    setChanges([{ projectPath: 'p', baseBranch: 'main', branchName: 'b', files: many }]);
    await nextTick();

    const wrapper = mount(DiffPanel);
    expect(wrapper.findAll('details')).toHaveLength(6);
    expect(wrapper.findAll('details').every((d) => !(d.element as HTMLDetailsElement).open)).toBe(true);
  });

  it('draws no ghost row for the newline a diff ends with', () => {
    // Real git output ends with `\n`; a naive split reads that as a blank
    // context line and draws an empty row under every file.
    const rows = mount(DiffPanel).findAll('tbody tr, table tr');
    expect(rows.at(-1)!.text().trim()).not.toBe('');
  });
});
