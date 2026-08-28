<script setup lang="ts">
/**
 * Sign in, or make an account.
 *
 * No server address on screen: it ships with the build, so it is not
 * something the person signing in chose, can change, or needs to read. When
 * the server cannot be reached at all, that is said in `session.error` —
 * with the address, because then it is the only thing that explains it.
 */
import { nextTick, onMounted, ref, watch } from 'vue';
import StateNote from './StateNote.vue';
import { session, signIn } from '../session';

const mode = ref<'login' | 'register'>('login');
const name = ref('');
const email = ref('');
const password = ref('');
const busy = ref(false);
const emailBox = ref<HTMLInputElement | null>(null);

onMounted(() => void nextTick(() => emailBox.value?.focus()));
watch(mode, () => (session.error = ''));

async function submit(): Promise<void> {
  busy.value = true;
  session.error = await signIn(mode.value, {
    name: name.value.trim(),
    email: email.value.trim(),
    password: password.value,
  });
  busy.value = false;
}
</script>

<template>
  <div id="gate">
    <div class="gate-card">
      <div class="gate-brand">
        <span class="brand-mark">Rv</span>
        <div>
          <h1>Revify</h1>
          <p class="brand-sub">jira → gitlab → ai review</p>
        </div>
      </div>

      <div>
        <div class="seg gateSeg">
          <button class="grow" :class="{ on: mode === 'login' }" @click="mode = 'login'">
            Giriş yap
          </button>
          <button class="grow" :class="{ on: mode === 'register' }" @click="mode = 'register'">
            Kaydol
          </button>
        </div>

        <label v-if="mode === 'register'" class="field">
          <span>İsim</span>
          <input v-model="name" class="input" autocomplete="name" />
        </label>
        <label class="field">
          <span>E-posta</span>
          <input ref="emailBox" v-model="email" class="input" type="email" autocomplete="username" @keydown.enter="submit" />
        </label>
        <label class="field">
          <span>Parola</span>
          <input
            v-model="password"
            class="input"
            type="password"
            :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
            @keydown.enter="submit"
          />
        </label>
        <p v-if="mode === 'register'" class="card-hint">En az 10, en fazla 72 karakter.</p>

        <div class="card-actions">
          <button class="btn btn-primary grow" :disabled="busy" @click="submit">
            {{ mode === 'register' ? 'Kaydol' : 'Giriş yap' }}
          </button>
        </div>
      </div>

      <StateNote v-if="session.error" kind="error">{{ session.error }}</StateNote>
    </div>
  </div>
</template>
