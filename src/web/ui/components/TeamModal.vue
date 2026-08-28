<script setup lang="ts">
/**
 * Who is on the team, what is outstanding, and who has already been asked.
 *
 * The nudge history is the point of the assignments list. A "sent" toast
 * says nothing; "3 kez hatırlatıldı, son 2 gün önce" says that asking again
 * is not the answer. Silence is the fact worth surfacing.
 */
import { computed, onMounted, ref } from 'vue';
import { closeModal } from '../uiState';
import { loadIdentity, loadTeams, session, signOut, type Team } from '../session';
import { sinceText } from '../format';

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface Assignment {
  issueKey: string;
  assigneeId: string;
  assigneeName?: string;
  assignedAt: string;
  status?: string;
}

interface Nudge {
  createdAt: string;
}

const team = ref<Team | null>(null);
const members = ref<Member[]>([]);
const assignments = ref<Assignment[]>([]);
const nudges = ref<Record<string, Nudge[]>>({});
const message = ref('');
const result = ref('');

const search = ref('');
const found = ref<Member[]>([]);
const newTeamName = ref('');

/** Open the row's note box rather than sending blind: a nudge with a reason
 * is a message, one without is a poke. */
const nudging = ref<string | null>(null);
const nudgeNote = ref('');
const nudgeError = ref<Record<string, string>>({});

const isOwner = computed(() => team.value?.role === 'owner');
const open = computed(() => assignments.value.filter((a) => a.status !== 'closed'));

async function load(): Promise<void> {
  message.value = '';
  await loadIdentity();

  if (!session.configured) {
    message.value = "Takım API adresi ayarlanmamış. Ayarlar'dan ekleyebilirsin.";
    return;
  }
  if (!session.user) {
    message.value = 'Sunucuya ulaşılamıyor. Takım özellikleri bağlantı geri gelince çalışır.';
    return;
  }

  const teams = await loadTeams();
  team.value = teams[0] ?? null;
  if (!team.value) return;

  const id = encodeURIComponent(team.value.id);
  try {
    members.value = (await (await fetch(`/api/backend/teams/${id}/members`)).json()).items ?? [];
  } catch {
    members.value = [];
  }
  try {
    assignments.value = (await (await fetch(`/api/backend/teams/${id}/assignments`)).json()).items ?? [];
  } catch {
    assignments.value = [];
    result.value = 'Takım atamaları okunamadı.';
    return;
  }

  // Who has already asked, before anyone asks again. Fetched per issue
  // rather than guessed: the button used to look identical whether you had
  // nudged nobody or four times.
  const history: Record<string, Nudge[]> = {};
  await Promise.all(
    open.value.map(async (a) => {
      try {
        history[a.issueKey] =
          (await (await fetch(`/api/reminders/nudges/${encodeURIComponent(a.issueKey)}`)).json())
            .items ?? [];
      } catch {
        history[a.issueKey] = [];
      }
    }),
  );
  nudges.value = history;
}

onMounted(load);

async function runSearch(): Promise<void> {
  const q = search.value.trim();
  if (q.length < 2) {
    found.value = [];
    return;
  }
  try {
    found.value = (await (await fetch(`/api/backend/users?q=${encodeURIComponent(q)}`)).json()).items ?? [];
  } catch {
    found.value = [];
  }
}

async function addMember(user: Member): Promise<void> {
  if (!team.value) return;
  const data = await (
    await fetch(`/api/backend/teams/${encodeURIComponent(team.value.id)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email }),
    })
  ).json();
  result.value = data.error ? `Eklenemedi: ${data.error}` : `${user.name} eklendi.`;
  search.value = '';
  found.value = [];
  await load();
}

async function createTeam(): Promise<void> {
  const name = newTeamName.value.trim();
  if (!name) return;
  const data = await (
    await fetch('/api/backend/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).json();
  if (data.error) {
    result.value = `Takım oluşturulamadı: ${data.error}`;
    return;
  }
  newTeamName.value = '';
  await load();
}

async function sendNudge(a: Assignment): Promise<void> {
  try {
    const data = await (
      await fetch('/api/reminders/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueKey: a.issueKey,
          toUserId: a.assigneeId,
          message: nudgeNote.value.trim(),
        }),
      })
    ).json();
    if (data.error) {
      // The server refuses a second ask inside half an hour and says when
      // the last one went out. Showing that beats a dead button.
      nudgeError.value = { ...nudgeError.value, [a.issueKey]: String(data.error) };
      nudging.value = null;
      return;
    }
    nudging.value = null;
    nudgeNote.value = '';
    await load();
  } catch (err) {
    nudgeError.value = { ...nudgeError.value, [a.issueKey]: (err as Error).message };
  }
}

async function logout(): Promise<void> {
  await signOut();
  closeModal('team');
}
</script>

<template>
  <div class="modal-backdrop open" @click.self="closeModal('team')">
    <div class="modal">
      <div class="modal-head">
        <h3>Takım</h3>
        <button class="btn btn-ghost btn-icon pushRight" title="Kapat" @click="closeModal('team')" aria-label="Kapat">
          ✕
        </button>
      </div>

      <div class="modal-body">
        <div v-if="message" class="section-empty">{{ message }}</div>

        <template v-else>
          <p class="card-hint">
            Giriş yapan: <b>{{ session.user?.name }}</b> · {{ session.user?.email }}
          </p>

          <template v-if="team">
            <h4>
              {{ team.name }}
              <span v-if="isOwner" class="role">sahip</span>
            </h4>
            <div v-for="m in members" :key="m.id" class="memberRow">
              <span>{{ m.name }}</span>
              <span class="muted">{{ m.email }}</span>
              <span class="spacer"></span>
              <span class="role">{{ m.role }}</span>
            </div>

            <template v-if="isOwner">
              <div class="note-add spaced">
                <input
                  v-model="search"
                  class="input"
                  placeholder="isim veya e-posta ara (en az 2 harf)"
                  @input="runSearch"
                />
              </div>
              <div>
                <div v-for="u in found" :key="u.id" class="memberRow pickable" @click="addMember(u)">
                  <span>{{ u.name }}</span>
                  <span class="muted">{{ u.email }}</span>
                  <span class="spacer"></span>
                  <span class="role">ekle</span>
                </div>
              </div>
            </template>

            <h4>Açık atamalar</h4>
            <p v-if="!open.length" class="card-hint">Takımda açık atama yok.</p>
            <div v-for="a in open" :key="a.issueKey" class="memberRow">
              <span>{{ a.issueKey }}</span>
              <span class="muted">
                {{ a.assigneeName || '—' }} · {{ sinceText(a.assignedAt) }} önce
                <template v-if="nudges[a.issueKey]?.length">
                  · <b>{{ nudges[a.issueKey].length }} kez hatırlatıldı</b>, son
                  {{ sinceText(nudges[a.issueKey][0].createdAt) }} önce
                </template>
              </span>
              <span class="spacer"></span>

              <span v-if="a.assigneeId === session.user?.id" class="role">sende</span>
              <span v-else-if="nudgeError[a.issueKey]" class="card-hint">
                {{ nudgeError[a.issueKey] }}
              </span>
              <template v-else-if="nudging === a.issueKey">
                <input
                  v-model="nudgeNote"
                  class="input nudgeInput"
                  placeholder="kısa not (isteğe bağlı)"
                  @keydown.enter="sendNudge(a)"
                />
                <button class="btn small primary" @click="sendNudge(a)">Gönder</button>
              </template>
              <button v-else class="btn small" @click="nudging = a.issueKey">Hatırlat</button>
            </div>
          </template>

          <template v-else>
            <h4>Takım yok</h4>
            <div class="note-add">
              <input v-model="newTeamName" class="input" placeholder="takım adı" @keydown.enter="createTeam" />
              <button class="btn btn-primary" @click="createTeam">Oluştur</button>
            </div>
          </template>

          <div class="card-actions">
            <button class="btn btn-ghost" @click="logout">Çıkış yap</button>
          </div>
          <div class="card-hint">{{ result }}</div>
        </template>
      </div>
    </div>
  </div>
</template>
