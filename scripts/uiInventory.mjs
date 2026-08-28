/**
 * The safety net for the Vue migration, and the feature checklist after it.
 *
 * It began by reading `index.html`, because that is where the application
 * was. The page is now a stylesheet and a mount point, so what it reads is
 * the components — and a control that vanishes from this list is a feature
 * that was lost, which is the one thing the migration was not allowed to do.
 *
 *   node scripts/uiInventory.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = 'src/web/ui';

function sourcesIn(dir, ...extensions) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesIn(join(dir, entry.name), ...extensions)
      : extensions.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

const uniq = (values) => [...new Set(values)].sort();

/** What a person reads on a control: its label, or a field's placeholder. */
const readable = (raw) =>
  raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{\{([^}]*)\}\}/g, (_m, expr) => `{${expr.trim().split(/[\s?:]/)[0]}}`)
    .replace(/\s+/g, ' ')
    .trim();

const components = sourcesIn(UI_DIR, '.vue')
  .map((path) => {
    const source = readFileSync(path, 'utf8');
    const template = source.slice(source.indexOf('<template>'));
    return {
      name: path.split('/').pop().replace('.vue', ''),
      path,
      controls: [
        ...[...template.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(
          (m) => `düğme: ${readable(m[1]) || '(ikon)'}`,
        ),
        ...[...template.matchAll(/<a[^>]*class="[^"]*btn[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map(
          (m) => `bağlantı: ${readable(m[1])}`,
        ),
        ...[...template.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(() => 'alan: onay kutusu'),
        ...[...template.matchAll(/placeholder="([^"]*)"/g)].map((m) => `alan: ${m[1].slice(0, 60)}`),
        ...[...template.matchAll(/<textarea[^>]*>/g)].map(() => 'alan: metin kutusu'),
        // A select has no placeholder to name it, and leaving it out made
        // the field count one short of the page it replaced.
        ...[...template.matchAll(/<select[^>]*>/g)].map(() => 'alan: seçim kutusu'),
        ...[...template.matchAll(/<input[^>]*type="file"[^>]*>/g)].map(() => 'alan: dosya seçici'),
      ],
      modal: /class="[^"]*\bmodal-backdrop\b/.test(template),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** Every path the client can call, in whichever quoting style it was written. */
const endpoints = uniq(
  sourcesIn(UI_DIR, '.ts', '.vue').flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/['"`](\/api\/[^'"`$]*)/g)].map((m) =>
      m[1].split('?')[0],
    ),
  ),
);

const controls = components.flatMap((c) => c.controls);
const count = (prefix) => controls.filter((c) => c.startsWith(prefix)).length;
const buttons = count('düğme') + count('bağlantı');
const fields = count('alan');
const modals = components.filter((c) => c.modal).length;

/** The page is a stylesheet and a mount point; anything left in it is a
 * surprise worth reporting. */
const page = readFileSync('src/web/public/index.html', 'utf8');
const pageScript = page.includes('<script>') ? 'VAR — sayfada hâlâ kod var' : 'yok';
const pageStyle = page.includes('<style>') ? 'VAR' : 'yok';

writeFileSync(
  'docs/ui-inventory.md',
  [
    '# Arayüz feature envanteri',
    '',
    '<!-- ÜRETİLMİŞ DOSYA — elle düzenleme. node scripts/uiInventory.mjs -->',
    '',
    'Buradaki bir satırın karşılığı arayüzde yoksa, o feature **kaybolmuş** demektir.',
    'Göçün nasıl yürüdüğü `ui-migration.md` içinde.',
    '',
    `- Sayfadaki inline script: **${pageScript}** · inline stil: **${pageStyle}**`,
    `- Bileşen: **${components.length}** · düğme: **${buttons}** · alan: **${fields}** · modal: **${modals}**`,
    `- API ucu: **${endpoints.length}**`,
    '',
    '## Bileşenler',
    ...components.flatMap((c) => [
      `### \`${c.name}\`${c.modal ? ' _(modal)_' : ''} — \`${c.path}\``,
      ...(c.controls.length ? c.controls.map((control) => `- [ ] ${control}`) : ['- _(kontrol yok)_']),
      '',
    ]),
    `## Kullanılan API uçları (${endpoints.length})`,
    ...endpoints.map((e) => `- [ ] \`${e}\``),
    '',
  ].join('\n'),
);

console.log(
  `bileşen ${components.length} · düğme ${buttons} · alan ${fields} · ` +
    `modal ${modals} · uç ${endpoints.length} · sayfada script: ${pageScript}, stil: ${pageStyle}`,
);
