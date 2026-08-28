<script setup lang="ts">
/**
 * Hand this issue to a team-mate.
 *
 * The review still runs on *their* machine with *their* credentials — the
 * server only records who gave what to whom, and why. Which is why the note
 * matters more than it looks: it is the only thing that travels.
 */
import { computed, onMounted, ref } from 'vue';
import { state } from '../bridge';
import { closeModal } from '../uiState';
import { loadIdentity, loadTeams, session } from '../session';

interface Member {
  id: string;
  name: string;
  email: string;
}

const members = ref<Member[]>([]);
const pickedId = ref<string | null>(null);
const note = ref('');
const result = ref('');
const teamId = ref<string | null>(null);
const busy = ref(false);

/** Everyone but you: assigning something to yourself is what not assigning
 * it already means. */
const others = computed(() => members.value.filter((m) => m.id !== session.user?.id));

async function load(): Promise<void> {
  await loadIdentity();
  if (!session.user) {
    result.value = 'Sunucuya ulaşılamıyor; şu an atama yapılamaz.';
    return;
  }
  const teams = await loadTeams();
  if (!teams.length) {
    result.value = 'Önce bir takım oluştur (Takım menüsü).';
    return;
  }
  teamId.value = teams[0].id;
  try {
    members.value =
      (await (await fetch(`/api/backend/teams/${encodeURIComponent(teams[0].id)}/members`)).json())
        .items ?? [];
  } catch {
    result.value = 'Takım üyeleri okunamadı.';
  }
}

onMounted(load);

async function assign(): Promise<void> {
  if (!pickedId.value || !teamId.value || !state.issueKey) return;
  busy.value = true;
  result.value = 'atanıyor…';
  try {
    const data = await (
      await fetch(`/api/backend/teams/${encodeURIComponent(teamId.value)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueKey: state.issueKey,
          assigneeId: pickedId.value,
          note: note.value.trim(),
        }),
      })
    ).json();
    if (data.error) {
      result.value = data.error;
      return;
    }
    closeModal('assign');
  } catch (err) {
    result.value = `Atanamadı: ${(err as Error).message}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop open" @click.self="closeModal('assign')">
    <div class="modal">
      <div class="modal-head">
        <h3>Ata</h3>
        <button class="btn btn-ghost btn-icon pushRight" title="Kapat" @click="closeModal('assign')" aria-label="Kapat">
          ✕
        </button>
      </div>

      <div class="modal-body">
        <p class="card-hint">{{ state.issueKey }} — {{ state.detail?.summary ?? '' }}</p>

        <h4>Kime</h4>
        <div>
          <div
            v-for="m in others"
            :key="m.id"
            class="memberRow pickable"
            :class="{ picked: pickedId === m.id }"
            @click="pickedId = m.id"
          >
            <span>{{ m.name }}</span>
            <span class="muted">{{ m.email }}</span>
          </div>
          <div v-if="!others.length" class="section-empty">
            Takımda başka kimse yok. Takım menüsünden birini ekleyebilirsin.
          </div>
        </div>

        <h4>Not</h4>
        <textarea v-model="note" rows="3" placeholder="Neye dikkat etmeli? (opsiyonel)"></textarea>
        <div class="card-hint">{{ result }}</div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="closeModal('assign')">Vazgeç</button>
        <button class="btn btn-primary" :disabled="!pickedId || busy" @click="assign">Ata</button>
      </div>
    </div>
  </div>
</template>
