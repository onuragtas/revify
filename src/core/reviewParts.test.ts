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
