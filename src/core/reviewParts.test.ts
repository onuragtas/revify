import { describe, expect, it } from 'vitest';
import { splitReview } from './reviewParts.js';

describe('splitReview', () => {
  const review = [
    'Özet cümlesi.',
    '',
    '### blocking — app/x.php:181',
    'Teklif akışı dokunulmamış.',
    '[?] Teklif ekranı hangi endpoint\'i çağırıyor?',
    '',
    'Verdict: Request changes',
    '',
    '[note] Test notu uygulandı: test yokluğunu raporlamadım.',
    '[note] Mongo notu uygulandı: fixture eksikliğini yazmadım.',
  ].join('\n');

  it('keeps only the reader-facing text in the body', () => {
    const { body } = splitReview(review);

    expect(body).toContain('### blocking — app/x.php:181');
    expect(body).toContain('Verdict: Request changes');
    expect(body).not.toContain('[?]');
    expect(body).not.toContain('[note]');
    expect(body).not.toContain('Test notu uygulandı');
  });

  it('extracts open questions and applied notes separately', () => {
    const { openQuestions, appliedNotes } = splitReview(review);

    expect(openQuestions).toEqual(["Teklif ekranı hangi endpoint'i çağırıyor?"]);
    expect(appliedNotes).toEqual([
      'Test notu uygulandı: test yokluğunu raporlamadım.',
      'Mongo notu uygulandı: fixture eksikliğini yazmadım.',
    ]);
  });

  it('does not leave blank holes where markers were removed', () => {
    const { body } = splitReview(review);

    expect(body).not.toMatch(/\n{3,}/);
    expect(body.startsWith('Özet')).toBe(true);
    expect(body.endsWith('Verdict: Request changes')).toBe(true);
  });

  it('de-duplicates repeated markers', () => {
    const { openQuestions, appliedNotes } = splitReview(
      ['[?] Aynı soru', '[?] Aynı soru', '[note] Aynı not', '[note] Aynı not'].join('\n'),
    );

    expect(openQuestions).toEqual(['Aynı soru']);
    expect(appliedNotes).toEqual(['Aynı not']);
  });

  it('matches the note marker case-insensitively', () => {
    expect(splitReview('[NOTE] büyük harf').appliedNotes).toEqual(['büyük harf']);
  });

  it('returns empty parts for a review with no markers', () => {
    const { body, openQuestions, appliedNotes } = splitReview('Sadece düz metin.');

    expect(body).toBe('Sadece düz metin.');
    expect(openQuestions).toEqual([]);
    expect(appliedNotes).toEqual([]);
  });
});

describe('splitReview — withdrawn findings', () => {
  it('keeps a withdrawal out of the body, where Jira would have shown it', () => {
    const parts = splitReview(
      ['## Bulgular', '', 'Tek bir sorun var.', '', '[withdrawn] Cache bulgusu — kod zaten TTL set ediyor.', '', 'Verdict: Approve'].join('\n'),
    );

    expect(parts.withdrawn).toEqual(['Cache bulgusu — kod zaten TTL set ediyor.']);
    expect(parts.body).not.toContain('withdrawn');
    expect(parts.body).toContain('Verdict: Approve');
    // The marker line left a hole; it must not become a paragraph break.
    expect(parts.body).not.toMatch(/\n{3,}/);
  });

  it('does not confuse a withdrawal with a note or a question', () => {
    const parts = splitReview(['[?] Soru?', '[note] Not.', '[withdrawn] Geri çekildi.'].join('\n'));

    expect(parts.openQuestions).toEqual(['Soru?']);
    expect(parts.appliedNotes).toEqual(['Not.']);
    expect(parts.withdrawn).toEqual(['Geri çekildi.']);
    expect(parts.body).toBe('');
  });
});

describe('[resolved] lines', () => {
  it('are lifted out of the review the way the other markers are', () => {
    /*
     * The visible half of a review that converges. Without it a second pass
     * reads as "here are some findings" all over again, with no way to tell
     * that three earlier ones are gone — which is what makes the loop feel
     * endless even when it is closing.
     */
    const parts = splitReview(
      [
        '### major — src/Bank.php:12',
        '',
        'Hâlâ null kontrolü yok.',
        '',
        'Verdict: Request changes',
        '',
        '[resolved] blocking — src/Payment.php:829 — refund() artık transaction içinde',
        '[resolved] major — src/Cache.php:5 — anahtar normalize ediliyor',
      ].join('\n'),
    );

    expect(parts.resolved).toEqual([
      'blocking — src/Payment.php:829 — refund() artık transaction içinde',
      'major — src/Cache.php:5 — anahtar normalize ediliyor',
    ]);
    // Internal, like the notes: Jira reads the review of the code as it
    // stands, not a diff against a draft it never saw.
    expect(parts.body).not.toContain('[resolved]');
    expect(parts.body).toContain('Hâlâ null kontrolü yok.');
  });

  it('is empty when nothing was closed', () => {
    expect(splitReview('Verdict: Approve').resolved).toEqual([]);
  });
});

describe('[answer] lines', () => {
  it('lifts the reply to an objection out of the review', () => {
    /*
     * An objection is not always "you are wrong" — often it is "is this
     * really so?", and there was nowhere for the answer to go. It would
     * land inside the finding if the finding survived, and vanish entirely
     * if it did not, which is the case where the question mattered most.
     */
    const parts = splitReview(
      [
        'Verdict: Approve',
        '',
        '[answer] blocking — src/Payment.php:829 — Evet, validate() çağrılıyor ama yalnızca POST yolunda.',
        '[withdrawn] blocking — src/Payment.php:829 — itiraz haklı, geri çekildi',
      ].join('\n'),
    );

    expect(parts.answers).toEqual([
      'blocking — src/Payment.php:829 — Evet, validate() çağrılıyor ama yalnızca POST yolunda.',
    ]);
    expect(parts.withdrawn).toHaveLength(1);
    // Internal, like the other markers: the question was ours, not Jira's.
    expect(parts.body).not.toContain('[answer]');
  });

  it('is empty when nothing was asked', () => {
    expect(splitReview('Verdict: Approve').answers).toEqual([]);
  });
});
