// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ActionMenu from './ActionMenu.vue';

const OPTS = { attachTo: document.body, slots: { default: '<button class="btn">Temizle</button>' } };

describe('ActionMenu', () => {
  it('stays shut until asked', () => {
    const wrapper = mount(ActionMenu, OPTS);
    expect(wrapper.find('.actionMenu-list').exists()).toBe(false);
    expect(wrapper.find('button').attributes('aria-expanded')).toBe('false');
  });

  it('names itself, since it is only a glyph', () => {
    expect(mount(ActionMenu, OPTS).find('button').attributes('aria-label')).toBe('Diğer eylemler');
  });

  it('closes once something in it was chosen', async () => {
    const wrapper = mount(ActionMenu, OPTS);
    await wrapper.find('.actionMenu > .btn').trigger('click');
    expect(wrapper.find('.actionMenu-list').text()).toContain('Temizle');

    await wrapper.find('.actionMenu-list .btn').trigger('click');
    expect(wrapper.find('.actionMenu-list').exists()).toBe(false);
    wrapper.unmount();
  });

  it('closes on a click elsewhere and on Escape', async () => {
    // A menu that survives a click somewhere else is a menu you dismiss twice.
    const wrapper = mount(ActionMenu, OPTS);

    await wrapper.find('.actionMenu > .btn').trigger('click');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(wrapper.find('.actionMenu-list').exists()).toBe(false);

    await wrapper.find('.actionMenu > .btn').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.find('.actionMenu-list').exists()).toBe(false);
    wrapper.unmount();
  });
});
