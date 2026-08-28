<script setup lang="ts">
/**
 * Everything this machine knows, and the policy its team shares.
 *
 * Two halves with different owners, side by side because a person thinks of
 * them as one screen. What is *this machine's* — credentials, whether it may
 * write to Jira at all, how long a run may take — stays here. What must be
 * the same for everyone who shares a Jira — the JQL, the statuses, the
 * review language — lives on the server and is read-only unless you own the
 * team: a status name changed by mistake reshapes everyone's queue.
 */
import { computed, onMounted, ref } from 'vue';
import { closeModal } from '../uiState';
import { loadIdentity, loadTeams, session } from '../session';
import { checkForUpdate, installUpdate, pollUpdate, updateState } from '../update';

/** Written back only when touched: sending an empty value would clear a
 * credential nobody meant to change. */
const SECRETS = ['jiraApiToken', 'gitlabToken', 'anthropicApiKey'] as const;

const TEXT_FIELDS = [
  ['jiraBaseUrl', 'Adres', 'https://sirket.atlassian.net', 'Jira'],
  ['jiraEmail', 'E-posta', 'siz@sirket.com', ''],
  ['jiraApiToken', 'API token', '', ''],
  ['gitlabBaseUrl', 'Adres', 'https://gitlab.sirket.com', 'GitLab'],
  ['gitlabToken', 'Token', '', ''],
  ['anthropicModel', 'Model', 'claude-opus-5', 'Model'],
  ['anthropicApiKey', 'API anahtarı', 'opsiyonel — boşsa claude CLI oturumu kullanılır', ''],
] as const;

const BOOL_FIELDS = [
  ['applyChanges', "Jira'ya gerçekten yaz (kapalıysa yalnızca loglanır)"],
  ['autoPrepareEnabled', 'Yeni gelen işleri ben istemeden incele'],
  ['useRepoCheckout', 'Repoyu klonla (model çevre kodu okuyabilsin)'],
] as const;

const TEAM_FIELDS = [
  ['jql', 'JQL', 'project = "PROJ" AND status = "Code Review"'],
  ['approveStatus', 'Onaylanınca durum', 'Ready for Stage'],
  ['rejectStatus', 'Reddedilince durum', 'In Development'],
  ['language', 'Review dili', 'Turkish'],
] as const;

const values = ref<Record<string, string>>({});
const secretSet = ref<Record<string, boolean>>({});
const bools = ref<Record<string, boolean>>({});
const minutes = ref<{ idle: string; run: string; poll: string }>({ idle: '', run: '', poll: '' });
const repoCacheDir = ref('');
const settingsPath = ref('');
const missing = ref<string[]>([]);
const result = ref('');
const saving = ref(false);

/* ------------------------------ team policy ------------------------------ */

const policy = ref<Record<string, string>>({});
const policyState = ref('');
const policyRole = ref<string | null>(null);
const policyTeamId = ref<string | null>(null);
const offerCreate = ref(false);
const newTeamName = ref('');

const canEditPolicy = computed(() => policyRole.value === 'owner');

async function loadPolicy(): Promise<void> {
  policyRole.value = null;
  policyTeamId.value = null;
  offerCreate.value = false;

  await loadIdentity();
  if (!session.user) {
    policyState.value = 'Politikayı görmek için giriş yapmalısın.';
    return;
  }

  const found = await loadTeams();
  // A fresh account has no team, so the policy it would follow does not
  // exist yet. Saying so and stopping made this a dead end — the way out is
  // one click, so it belongs here rather than in another screen.
  if (!found.length) {
    offerCreate.value = true;
    policyState.value = 'Henüz bir takımın yok.';
    return;
  }

  const team = found[0];
  policyTeamId.value = team.id;
  try {
    const data = await (
      await fetch(`/api/backend/teams/${encodeURIComponent(team.id)}/settings`)
    ).json();
    if (data.error) {
      policyState.value = String(data.error);
      return;
    }
    policyRole.value = data.role;
    policy.value = Object.fromEntries(TEAM_FIELDS.map(([key]) => [key, data.settings[key] ?? '']));
    policyState.value =
      data.role === 'owner'
        ? `${team.name} — sahibi sensin, değiştirebilirsin.`
        : `${team.name} — takım sahibi belirler, sen yalnızca görürsün.`;
  } catch (err) {
    policyState.value = `Politika okunamadı: ${(err as Error).message}`;
  }
}

async function createTeam(): Promise<void> {
  const name = newTeamName.value.trim();
  if (!name) return;
  policyState.value = 'Oluşturuluyor…';
  try {
    const data = await (
      await fetch('/api/backend/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    ).json();
    if (data.error) {
      policyState.value = `Takım oluşturulamadı: ${data.error}`;
      return;
    }
    newTeamName.value = '';
    await loadPolicy();
  } catch (err) {
    policyState.value = `Takım oluşturulamadı: ${(err as Error).message}`;
  }
}

/* --------------------------------- load ---------------------------------- */

async function load(): Promise<void> {
  let data;
  try {
    data = await (await fetch('/api/settings')).json();
  } catch (err) {
    result.value = `Ayarlar okunamadı: ${(err as Error).message}`;
    return;
  }

  settingsPath.value = data.settingsPath;
  missing.value = data.setup?.configured ? [] : (data.setup?.missing ?? []);

  values.value = Object.fromEntries(
    TEXT_FIELDS.map(([key]) => [key, SECRETS.includes(key as never) ? '' : (data.settings[key] ?? '')]),
  );
  secretSet.value = Object.fromEntries(SECRETS.map((key) => [key, Boolean(data.settings[key])]));
  bools.value = Object.fromEntries(BOOL_FIELDS.map(([key]) => [key, Boolean(data.settings[key])]));
  repoCacheDir.value = data.settings.repoCacheDir ?? '';

  // Milliseconds are what the pipeline wants and minutes are what a person
  // thinks in; the conversion lives here rather than in anyone's head.
  minutes.value = {
    poll: data.settings.autoPreparePollMs ? String(Math.round(data.settings.autoPreparePollMs / 1000)) : '',
    idle: data.settings.idleTimeoutMs ? String(Math.round(data.settings.idleTimeoutMs / 60000)) : '',
    run: data.settings.runTimeoutMs ? String(Math.round(data.settings.runTimeoutMs / 60000)) : '',
  };

  await loadPolicy();
  await pollUpdate();
}

onMounted(load);

/* --------------------------------- save ---------------------------------- */

async function save(): Promise<void> {
  saving.value = true;
  result.value = 'kaydediliyor…';

  const patch: Record<string, unknown> = { repoCacheDir: repoCacheDir.value };
  for (const [key] of TEXT_FIELDS) {
    const value = values.value[key] ?? '';
    if (SECRETS.includes(key as never) && value === '') continue;
    patch[key] = value;
  }
  for (const [key] of BOOL_FIELDS) patch[key] = bools.value[key];

  // Left blank means "use the built-in default", so a blank field must not be
  // sent as a zero — the server would reject it and the save would look
  // broken for a field nobody touched.
  const seconds = Number(minutes.value.poll);
  if (Number.isFinite(seconds) && seconds > 0) patch.autoPreparePollMs = seconds * 1000;
  for (const [field, key] of [['idle', 'idleTimeoutMs'], ['run', 'runTimeoutMs']] as const) {
    const value = Number(minutes.value[field]);
    if (Number.isFinite(value) && value > 0) patch[key] = value * 60000;
  }

  try {
    const data = await (
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    ).json();
    if (data.error) {
      result.value = `Kaydedilemedi: ${data.error}`;
      return;
    }

    // The team half is a separate call: it goes to the server, and only an
    // owner may make it.
    if (canEditPolicy.value && policyTeamId.value) {
      const teamData = await (
        await fetch(`/api/backend/teams/${encodeURIComponent(policyTeamId.value)}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(policy.value),
        })
      ).json();
      if (teamData.error) {
        result.value = `Makine ayarları kaydedildi, takım politikası kaydedilemedi: ${teamData.error}`;
        return;
      }
    }

    result.value = data.applied
      ? 'Kaydedildi ve uygulandı.'
      : `Kaydedildi, ama uygulanamadı: ${data.applyError ?? 'bilinmeyen hata'}`;
    await load();
  } catch (err) {
    result.value = `Kaydedilemedi: ${(err as Error).message}`;
  } finally {
    saving.value = false;
  }
}

/* -------------------------------- version -------------------------------- */

const checking = ref(false);
const versionNote = ref('');

async function check(): Promise<void> {
  checking.value = true;
  versionNote.value = 'Kontrol ediliyor…';
  versionNote.value = await checkForUpdate();
  checking.value = false;
}

async function act(): Promise<void> {
  versionNote.value = await installUpdate();
}
</script>

<template>
  <div class="modal-backdrop open" @click.self="closeModal('settings')">
    <div class="modal">
      <div class="modal-head">
        <h3>Ayarlar</h3>
        <button class="btn btn-ghost btn-icon pushRight" title="Kapat" @click="closeModal('settings')" aria-label="Kapat">
          ✕
        </button>
      </div>

      <div class="modal-body">
        <p class="card-hint">
          <template v-if="missing.length">
            <b class="warn">Eksik: {{ missing.join(', ') }}</b><br />
          </template>
          Bu makinede saklanır: {{ settingsPath }} — parola ve token'lar şifrelenir, dosya 0600.
          <template v-if="missing.length"><br />Kaydettiğin anda geçerli olur.</template>
        </p>

        <template v-for="[key, label, placeholder, heading] in TEXT_FIELDS" :key="key">
          <h4 v-if="heading">{{ heading }}</h4>
          <label class="field">
            <span>{{ label }}</span>
            <input
              v-model="values[key]"
              class="input"
              :type="SECRETS.includes(key as never) ? 'password' : 'text'"
              :placeholder="
                SECRETS.includes(key as never)
                  ? secretSet[key]
                    ? '•••••••• (kayıtlı — değiştirmek için yaz)'
                    : placeholder || 'ayarlanmamış'
                  : placeholder
              "
            />
          </label>
        </template>

        <h4>Bu makine</h4>
        <p class="card-hint">
          Kişisel ve operasyonel ayarlar. <b>Jira'ya yaz</b> bilerek takım geneli değil —
          güvenlik kilidi, ve başkasının açabildiği bir kilit kilit değildir.
        </p>
        <label v-for="[key, label] in BOOL_FIELDS" :key="key" class="field checkbox">
          <input v-model="bools[key]" type="checkbox" />
          <span>{{ label }}</span>
        </label>
        <label class="field">
          <span>Otomatik hazırlık aralığı (sn)</span>
          <input v-model="minutes.poll" class="input" type="number" min="10" />
        </label>
        <label class="field">
          <span>Repo cache dizini</span>
          <input v-model="repoCacheDir" class="input" placeholder="~/.revify/repos" />
        </label>
        <label class="field">
          <span>Sessizlik sınırı (dk)</span>
          <input v-model="minutes.idle" class="input" type="number" min="1" placeholder="10" />
        </label>
        <label class="field">
          <span>Azami çalışma süresi (dk)</span>
          <input v-model="minutes.run" class="input" type="number" min="1" placeholder="45" />
        </label>
        <p class="card-hint">
          Model hiçbir şey yazmadan <b>sessizlik sınırı</b> kadar geçerse takıldı sayılır ve
          durdurulur. Araç çağrılarını anlatmaya devam ettiği sürece ne kadar uzun sürerse sürsün
          çalışmaya devam eder — <b>azami süre</b> yalnızca sonsuz döngüye karşı bir tavandır.
          Büyük repolarda ikisini de artırabilirsin; takılan bir çalışmayı zaten <b>Durdur</b> ile
          kesebiliyorsun.
        </p>

        <h4>Takım politikası</h4>
        <p class="card-hint">
          Aynı Jira'ya yazdığınız için bunlar herkeste aynı olmalı; sunucuda tutulur.
        </p>
        <label v-for="[key, label, placeholder] in TEAM_FIELDS" :key="key" class="field">
          <span>{{ label }}</span>
          <input
            v-model="policy[key]"
            class="input"
            :placeholder="placeholder"
            :disabled="!canEditPolicy"
          />
        </label>
        <div v-if="offerCreate" class="note-add">
          <input
            v-model="newTeamName"
            class="input"
            placeholder="takım adı"
            @keydown.enter="createTeam"
          />
          <button class="btn btn-primary" @click="createTeam">Oluştur</button>
        </div>
        <div class="card-hint">{{ policyState }}</div>

        <h4>Sürüm</h4>
        <div class="teamCreateRow">
          <span class="card-hint grow">{{ versionNote || updateState.text }}</span>
          <button v-if="updateState.action" type="button" class="btn small" @click="act">
            {{ updateState.action }}
          </button>
          <button type="button" class="btn small" :disabled="checking" @click="check">
            Şimdi kontrol et
          </button>
        </div>

        <div class="card-hint">{{ result }}</div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="closeModal('settings')">Kapat</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">Kaydet</button>
      </div>
    </div>
  </div>
</template>
